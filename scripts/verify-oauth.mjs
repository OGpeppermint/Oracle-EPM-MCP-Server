import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { beginOracleLogin, oracleAuthorizationHeader, oracleLoginStatus, startOracleOAuthListener, stopOracleOAuthListener } from "../dist/oracle-oauth.js";
import { epmRequest } from "../dist/oracle-client.js";
import { readOAuthConfig, validateOracleConfig, ConfigurationError } from "../dist/config.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("OAuth configuration rejects incomplete or unsafe setup", () => {
  const base = { EPM_AUTH_MODE: "oauth", EPM_BASE_URL: "https://epm.example.test",
    EPM_OAUTH_DOMAIN_URL: "https://identity.example.test", EPM_OAUTH_CLIENT_ID: "public-client",
    EPM_OAUTH_SCOPE: "urn:opc:serviceInstanceID=123urn:opc:resource:consumer::all" };
  assert.equal(validateOracleConfig(base), base.EPM_BASE_URL);
  assert.deepEqual(readOAuthConfig(base), { domainUrl: base.EPM_OAUTH_DOMAIN_URL, clientId: "public-client", scope: base.EPM_OAUTH_SCOPE, callbackPort: 3002 });
  for (const change of [ { EPM_OAUTH_DOMAIN_URL: "http://bad.example.test" }, { EPM_OAUTH_CLIENT_ID: "" },
    { EPM_OAUTH_SCOPE: "openid" }, { EPM_OAUTH_CALLBACK_PORT: "0" } ]) {
    assert.throws(() => validateOracleConfig({ ...base, ...change }), ConfigurationError);
  }
});

test("browser authorization uses PKCE, callback exchanges code, Oracle requests use bearer, and refresh rotates", async () => {
  const port = await freePort();
  const keys = ["EPM_AUTH_MODE", "EPM_BASE_URL", "EPM_OAUTH_DOMAIN_URL", "EPM_OAUTH_CLIENT_ID", "EPM_OAUTH_SCOPE", "EPM_OAUTH_CALLBACK_PORT", "EPM_USERNAME", "EPM_PASSWORD"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, { EPM_AUTH_MODE: "oauth", EPM_BASE_URL: "https://epm.example.test",
    EPM_OAUTH_DOMAIN_URL: "https://identity.example.test", EPM_OAUTH_CLIENT_ID: "public-client",
    EPM_OAUTH_SCOPE: "urn:opc:serviceInstanceID=123urn:opc:resource:consumer::all", EPM_OAUTH_CALLBACK_PORT: String(port) });
  delete process.env.EPM_USERNAME;
  delete process.env.EPM_PASSWORD;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/oauth2/v1/token")) {
      const grant = init.body.get("grant_type");
      if (grant === "authorization_code") return Response.json({ access_token: "first-access", token_type: "Bearer", expires_in: 1, refresh_token: "first-refresh" });
      assert.equal(init.body.get("refresh_token"), "first-refresh");
      return Response.json({ access_token: "second-access", token_type: "Bearer", expires_in: 3600, refresh_token: "second-refresh" });
    }
    assert.equal(init.headers.get("Authorization"), "Bearer second-access");
    return Response.json({ items: [1] });
  };
  try {
    await startOracleOAuthListener();
    assert.equal(oracleLoginStatus().signedIn, false);
    const login = beginOracleLogin({ launchBrowser: false });
    const url = new URL(login.authorizationUrl);
    assert.equal(url.origin, "https://identity.example.test");
    assert.equal(url.pathname, "/oauth2/v1/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope"), /offline_access$/);
    const callback = url.searchParams.get("redirect_uri");
    const invalid = await oldFetch(`${callback}?state=wrong&code=bad`);
    assert.equal(invalid.status, 400);
    const response = await oldFetch(`${callback}?state=${encodeURIComponent(url.searchParams.get("state"))}&code=good`);
    assert.equal(response.status, 200);
    assert.equal(oracleLoginStatus().signedIn, true);
    assert.equal(requests[0].init.body.get("code"), "good");
    assert.equal(requests[0].init.body.get("redirect_uri"), callback);
    assert.equal(requests[0].init.body.get("client_id"), "public-client");
    const verifier = requests[0].init.body.get("code_verifier");
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));
    assert.equal(await oracleAuthorizationHeader(), "Bearer second-access");
    assert.deepEqual(await epmRequest("/test"), { items: [1] });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].init.body.get("grant_type"), "refresh_token");
    assert.equal(requests[2].url, "https://epm.example.test/test");
    const replay = await oldFetch(`${callback}?state=${encodeURIComponent(url.searchParams.get("state"))}&code=good`);
    assert.equal(replay.status, 400);
  } finally {
    await stopOracleOAuthListener();
    globalThis.fetch = oldFetch;
    for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
});
