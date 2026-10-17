// Test-only upstream responses deliberately contain synthetic secrets.
const privateText = [
  process.env.EPM_USERNAME, process.env.EPM_PASSWORD, process.env.EPM_APPLICATION,
  Buffer.from(`${process.env.EPM_USERNAME}:${process.env.EPM_PASSWORD}`).toString("base64"),
  "fixture-bearer-token", "fixture-cookie-value", "fixture-argument-value",
].join(" ");
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = (milliseconds) => originalTimeout(milliseconds === 30000 ? 100 : milliseconds);

globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://example.oraclecloud.com/")) throw new Error("Unexpected fixture request.");
  const scenario = decodeURIComponent(new URL(url).pathname.split("/")[5] ?? "success");
  if (scenario.startsWith("http-")) {
    return new Response(privateText, {
      status: Number(scenario.slice(5)), statusText: "Private upstream diagnostic",
      headers: { "Content-Type": `text/plain; private=${process.env.EPM_PASSWORD}` },
    });
  }
  if (scenario === "network-error") throw new Error(privateText);
  if (scenario === "timeout") {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  }
  if (scenario === "invalid-json") return new Response(`{"private": ${privateText}`, { headers: { "Content-Type": "application/json" } });
  if (scenario === "invalid-format") return new Response(`<html>${privateText}</html>`, { headers: { "Content-Type": "text/html" } });
  if (scenario === "summary-fallback") {
    return options.headers.get("Accept") === "*/*"
      ? new Response("Safe Markdown summary", { headers: { "Content-Type": "text/markdown" } })
      : new Response(privateText, { status: 406 });
  }
  return new Response(JSON.stringify({ items: [{ name: "Safe result" }] }), { headers: { "Content-Type": "application/json" } });
};

await import("../../dist/main.js");
