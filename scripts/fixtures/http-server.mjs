// Protocol verification must never send an Oracle request, even if input validation regresses.
globalThis.fetch = async () => {
  process.stderr.write(`${JSON.stringify({ event: "fixture.oracle.unexpected" })}\n`);
  throw new Error("Unexpected Oracle request during HTTP protocol verification.");
};

await import("../../dist/main.js");
