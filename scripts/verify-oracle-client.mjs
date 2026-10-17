import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { closeOracleRequests, epmRequest } from "../dist/oracle-client.js";
import { withRequestContext } from "../dist/logging.js";

const json = (value = { items: ["ok"] }, headers = {}) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json", ...headers },
});
const failure = (code) => (error) => { assert.equal(error.code, code); return true; };
const privateMarker = "oracle-client-private-marker";

test.beforeEach((t) => {
  // Mock streams have no socket; keep timeout-only operations alive until their deadline.
  const keepAlive = setTimeout(() => {}, 10000);
  t.after(() => clearTimeout(keepAlive));
  const settings = {
    EPM_BASE_URL: "https://example.oraclecloud.com", EPM_USERNAME: privateMarker,
    EPM_PASSWORD: privateMarker, EPM_REQUEST_TIMEOUT_MS: "5000", EPM_MAX_RETRIES: "2", EPM_MAX_RESPONSE_BYTES: "1024",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(async () => {
    await closeOracleRequests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});

test("GET retries use exponential backoff, keep correlation, and stop at the retry budget", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const records = [];
  t.mock.method(process.stderr, "write", (line) => { records.push(JSON.parse(line)); return true; });
  let calls = 0;
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
  });
  await assert.rejects(withRequestContext(() => epmRequest(`/private/${privateMarker}`)), failure("EPM_HTTP_ERROR"));
  assert.equal(calls, 3);
  assert.equal(cancelled, 3);
  assert.deepEqual(records.map(({ event, attempt, delayMs, status }) => ({ event, attempt, delayMs, status })), [
    { event: "oracle.request.retry", attempt: 2, delayMs: 250, status: 503 },
    { event: "oracle.request.retry", attempt: 3, delayMs: 500, status: 503 },
  ]);
  assert.equal(new Set(records.map(({ requestId }) => requestId)).size, 1);
  assert.match(records[0].requestId, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(records).includes(privateMarker));
});

test("transient HTTP statuses and network failures can recover on a later GET", async (t) => {
  t.mock.method(Math, "random", () => 0);
  for (const first of [429, 502, 503, 504, "network"]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 1) return json();
      if (first === "network") throw new TypeError(privateMarker, { cause: { code: "ECONNRESET" } });
      return new Response(privateMarker, { status: first });
    });
    assert.deepEqual(await epmRequest("/test"), { items: ["ok"] });
    assert.equal(calls, 2);
  }
});

test("permanent errors, invalid responses, disabled retries, and POST are not retried", async (t) => {
  for (const status of [400, 401, 403, 404, 406, 500, 501]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(privateMarker, { status }); });
    await assert.rejects(epmRequest("/test"), failure("EPM_HTTP_ERROR"));
    assert.equal(calls, 1);
  }
  for (const contentType of ["application/json", "text/html"]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(privateMarker, { headers: { "Content-Type": contentType } }));
    await assert.rejects(epmRequest("/test"), failure("EPM_RESPONSE_FORMAT"));
    assert.equal(mock.mock.callCount(), 1);
  }
  const tls = t.mock.method(globalThis, "fetch", async () => { throw new TypeError(privateMarker, { cause: { code: "CERT_HAS_EXPIRED" } }); });
  await assert.rejects(epmRequest("/test"), failure("EPM_NETWORK_ERROR"));
  assert.equal(tls.mock.callCount(), 1);
  const post = t.mock.method(globalThis, "fetch", async () => new Response(privateMarker, { status: 503 }));
  await assert.rejects(epmRequest("/test", { method: "POST", body: "{}" }), failure("EPM_HTTP_ERROR"));
  assert.equal(post.mock.callCount(), 1);
  process.env.EPM_MAX_RETRIES = "0";
  const noRetries = t.mock.method(globalThis, "fetch", async () => new Response(privateMarker, { status: 503 }));
  await assert.rejects(epmRequest("/test"), failure("EPM_HTTP_ERROR"));
  assert.equal(noRetries.mock.callCount(), 1);
});

test("Retry-After supports seconds and HTTP dates without retrying before Oracle permits", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const value of ["1", new Date(Math.ceil(now / 1000) * 1000 + 1000).toUTCString()]) {
    let calls = 0;
    const times = [];
    t.mock.method(globalThis, "fetch", async () => {
      times.push(performance.now());
      return ++calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": value } }) : json();
    });
    await epmRequest("/test");
    const minimum = value === "1" ? 1000 : Date.parse(value) - now;
    assert.ok(times[1] - times[0] >= minimum - 20);
    assert.equal(calls, 2);
  }
  for (const value of ["60", "999999999999999999999", new Date(now + 60000).toUTCString()]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503, headers: { "Retry-After": value } }));
    await assert.rejects(epmRequest("/test"), failure("EPM_HTTP_ERROR"));
    assert.equal(mock.mock.callCount(), 1);
  }
});

test("invalid Retry-After uses jitter and caller cancellation interrupts the wait", async (t) => {
  t.mock.method(Math, "random", () => 1);
  let stopWaiting;
  const records = [];
  t.mock.method(process.stderr, "write", (line) => { records.push(JSON.parse(line)); stopWaiting?.(); return true; });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503, headers: { "Retry-After": "-1.5" } }));
  const controller = new AbortController();
  const waiting = new Promise((resolve) => { stopWaiting = resolve; });
  const request = epmRequest("/test", { signal: controller.signal });
  await waiting;
  assert.equal(records[0].delayMs, 500);
  controller.abort();
  await assert.rejects(request, failure("EPM_ABORTED"));
});

test("summary compatibility shares the retry budget, deadline, and abort signal", async (t) => {
  t.mock.method(Math, "random", () => 0);
  process.env.EPM_MAX_RETRIES = "1";
  const accepts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    accepts.push(options.headers.get("Accept"));
    return new Response("", { status: accepts.length === 2 ? 406 : 503 });
  });
  await assert.rejects(epmRequest("/summary", undefined, { summaryFallback: true }), failure("EPM_HTTP_ERROR"));
  assert.deepEqual(accepts, ["application/json", "application/json", "*/*"]);

  process.env.EPM_REQUEST_TIMEOUT_MS = "150";
  const signals = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) { await delay(50); return new Response("", { status: 406 }); }
    return new Response(new ReadableStream());
  });
  await assert.rejects(epmRequest("/summary", undefined, { summaryFallback: true }), failure("EPM_TIMEOUT"));
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test("retries reuse one deadline rather than granting each attempt a fresh timeout", async (t) => {
  process.env.EPM_REQUEST_TIMEOUT_MS = "400";
  t.mock.method(Math, "random", () => 0);
  const signals = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) return new Response("", { status: 503 });
    return new Response(new ReadableStream());
  });
  await assert.rejects(epmRequest("/test"), failure("EPM_TIMEOUT"));
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test("summary fallback works with retries disabled and does not loop on a second 406", async (t) => {
  process.env.EPM_MAX_RETRIES = "0";
  for (const success of [true, false]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      if (options.headers.get("Accept") === "*/*" && success) return new Response("Summary", { headers: { "Content-Type": "text/markdown" } });
      return new Response("", { status: 406 });
    });
    if (success) assert.equal(await epmRequest("/summary", undefined, { summaryFallback: true }), "Summary");
    else await assert.rejects(epmRequest("/summary", undefined, { summaryFallback: true }), failure("EPM_HTTP_ERROR"));
    assert.equal(calls, 2);
  }
});

test("retry log attempt numbers include the summary compatibility request", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const records = [];
  t.mock.method(process.stderr, "write", (line) => { records.push(JSON.parse(line)); return true; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 406 })
      : calls === 2 ? new Response("", { status: 503 }) : json();
  });
  assert.deepEqual(await epmRequest("/summary", undefined, { summaryFallback: true }), { items: ["ok"] });
  assert.equal(records[0].attempt, 3);
  assert.equal(calls, 3);
});

test("response limits reject advertised and streamed bytes, including decoded compressed bodies", async (t) => {
  process.env.EPM_MAX_RESPONSE_BYTES = "8";
  for (const headers of [{ "Content-Length": "9" }, {}, { "Content-Encoding": "gzip", "Content-Length": "1" }]) {
    let cancelled = false;
    let index = 0;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode(index++ === 0 ? "1234" : "56789")); },
      cancel() { cancelled = true; },
    });
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(stream, { headers }));
    await assert.rejects(epmRequest("/test"), (error) => {
      assert.equal(error.code, "EPM_RESPONSE_TOO_LARGE");
      assert.match(error.message, /paginate/);
      return true;
    });
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(cancelled, true);
  }
});

test("response limits count UTF-8 bytes while preserving exact-limit JSON and text", async (t) => {
  process.env.EPM_MAX_RESPONSE_BYTES = "4";
  for (const [body, type, expected] of [["1234", "application/json", 1234], ["éé", "text/plain", "éé"], ["abcd", "text/markdown", "abcd"]]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": type } }));
    assert.equal(await epmRequest("/test"), expected);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("ééé", { headers: { "Content-Type": "text/plain" } }));
  await assert.rejects(epmRequest("/test"), failure("EPM_RESPONSE_TOO_LARGE"));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.deepEqual(await epmRequest("/test"), {});
});

test("the shared deadline interrupts a stalled body without starting another attempt", async (t) => {
  process.env.EPM_REQUEST_TIMEOUT_MS = "50";
  let cancelled = false;
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  // AbortSignal.timeout is unref'ed; a real HTTP socket normally keeps the process alive.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(epmRequest("/test"), failure("EPM_TIMEOUT"));
  assert.equal(cancelled, true);
  assert.equal(mock.mock.callCount(), 1);
});

test("shutdown cancels retry waits immediately and prevents another fetch", async (t) => {
  let waiting;
  const scheduled = new Promise((resolve) => { waiting = resolve; });
  t.mock.method(process.stderr, "write", () => { waiting(); return true; });
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const request = epmRequest("/test");
  const rejected = assert.rejects(request, failure("EPM_ABORTED"));
  await scheduled;
  await closeOracleRequests();
  await rejected;
  assert.equal(mock.mock.callCount(), 1);
});
