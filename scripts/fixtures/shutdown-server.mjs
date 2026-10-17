// Test-only Oracle stub and signal bridge. No shutdown controls are exposed by the service.
let releaseOracle;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://example.oraclecloud.com/")) throw new Error("Unexpected fixture request.");
  return new Promise((resolve, reject) => {
    const abort = () => reject(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    releaseOracle = () => {
      options.signal.removeEventListener("abort", abort);
      resolve(new Response(JSON.stringify({ items: [{ version: "v3" }] }), {
        headers: { "Content-Type": "application/json" },
      }));
    };
    process.send({ type: "oracle-started" });
  });
};

process.on("message", (message) => {
  if (message.type !== "prepare-shutdown") return;
  if (message.releaseAfterMs !== undefined) setTimeout(() => releaseOracle?.(), message.releaseAfterMs);
  process.send({ type: "prepared" }, () => {
    // Windows child.kill() forcibly terminates instead of delivering POSIX signals.
    if (message.emitSignal) {
      process.emit(message.signal);
      if (message.repeat) process.emit(message.signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
    }
    process.disconnect();
  });
});

await import("../../dist/main.js");
