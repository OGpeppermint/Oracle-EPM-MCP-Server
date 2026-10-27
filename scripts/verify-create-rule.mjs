import assert from "node:assert/strict";
import test from "node:test";
import { createRule, CreateRuleError } from "../dist/create-rule.js";

const input = { application: "APP1", planType: "Plan1", name: "NewRule", script: '"X" = 1;' };
const bytes = Buffer.from("PK\x03\x04fixture", "binary");
const build = async (request) => {
  assert.equal(request.mode, "combined");
  assert.equal(request.application, "APP1");
  return { bytes, sha256: "fixture-sha", filename: "fixture.zip", artifacts: [{
    kind: "rule", application: "APP1", plan_type: "Plan1", name: "NewRule",
  }], entryCount: 6 };
};
const link = (href) => ({ href, rel: "Job Status", action: "GET" });

test("one call builds, uploads, extracts, imports and waits before reporting success", async () => {
  const seen = [];
  const queue = [
    { status: 0, links: [link("https://epm.example/interop/rest/v2/files/upload/42")] },
    { status: 0 },
    { status: -1, links: [link("https://epm.example/interop/rest/v2/status/jobs/43")] },
    { status: -1 }, { status: 0 },
    { status: -1, links: [link("https://epm.example/interop/rest/v2/status/migration/44")] },
    { status: 0 },
  ];
  const request = async (path, init) => {
    seen.push({ path, init });
    return queue.shift();
  };
  const result = await createRule(input, { request, build, sleep: async () => {}, pollIntervalMs: 1, pollTimeoutMs: 1000 });
  assert.equal(result.stage, "import_completed");
  assert.equal(result.importJobId, "44");
  assert.equal(result.snapshotSha256, "fixture-sha");
  assert.equal(result.importedArtifacts[0].name, "NewRule");
  assert.deepEqual(seen.map((x) => [x.init?.method ?? "GET", x.path.replace(/mcp-rule-\d+-[a-f0-9]+/, "SNAPSHOT")]), [
    ["POST", "/interop/rest/v2/files/upload"],
    ["PATCH", "/interop/rest/v2/files/upload/42"],
    ["POST", "/interop/rest/v2/files/upload/42/complete"],
    ["GET", "/interop/rest/v2/status/jobs/43"],
    ["GET", "/interop/rest/v2/status/jobs/43"],
    ["POST", "/interop/rest/v2/snapshots/import"],
    ["GET", "/interop/rest/v2/status/migration/44"],
  ]);
  assert.equal(seen[1].init.headers["Chunk-Range"], `0-${bytes.length - 1}`);
  assert.deepEqual(Buffer.from(seen[1].init.body), bytes);
  assert.equal(JSON.parse(seen[0].init.body).fileSize, bytes.length);
  assert.equal(JSON.parse(seen[5].init.body).snapshotName, result.snapshotName);
  assert.equal(JSON.parse(seen[5].init.body).parameters.importUsers, false);
  assert.equal(queue.length, 0);
});

test("invalid snapshot prevents all Oracle requests", async () => {
  let calls = 0;
  await assert.rejects(createRule(input, { build: async () => { throw new Error("broken"); },
    request: async () => { calls++; throw new Error("unexpected call"); } }),
    (error) => error instanceof CreateRuleError && error.stage === "snapshot");
  assert.equal(calls, 0);
});

test("upload rejection stops before import and reports the upload stage", async () => {
  let calls = 0;
  await assert.rejects(createRule(input, { build, request: async () => {
    calls++;
    return calls === 1 ? { status: 0, links: [link("https://epm.example/interop/rest/v2/files/upload/42")] }
      : { status: 7, details: "Chunk rejected" };
  } }), (error) => error instanceof CreateRuleError && error.stage === "upload"
    && error.code === "EPM_MIGRATION_REJECTED" && error.uploadJobId === "42");
  assert.equal(calls, 2);
});

test("import failure never reports rule creation as success", async () => {
  const queue = [
    { status: 0, links: [link("/interop/rest/v2/files/upload/10")] },
    { status: 0 }, { status: 0 },
    { status: -1, links: [link("/interop/rest/v2/status/migration/11")] },
    { status: 1, details: "Rule rejected" },
  ];
  await assert.rejects(createRule(input, { build, request: async () => queue.shift() }),
    (error) => error instanceof CreateRuleError && error.stage === "import"
      && error.importJobId === "11" && error.code === "EPM_MIGRATION_REJECTED");
  assert.equal(queue.length, 0);
});

test("pending job timeout reports uncertain remote outcome", async () => {
  const queue = [
    { status: 0, links: [link("/interop/rest/v2/files/upload/10")] },
    { status: 0 },
    { status: -1, links: [link("/interop/rest/v2/status/jobs/11")] },
  ];
  await assert.rejects(createRule(input, { build, request: async () => queue.shift() ?? { status: -1 },
    sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 3)); },
    pollIntervalMs: 1, pollTimeoutMs: 2 }),
    (error) => error instanceof CreateRuleError && error.stage === "extraction"
      && error.outcomeUncertain && error.extractionJobId === "11");
});

test("missing upload job identifier is a structured error", async () => {
  await assert.rejects(createRule(input, { build, request: async () => ({ status: 0, links: [] }) }),
    (error) => error instanceof CreateRuleError && error.stage === "upload"
      && error.code === "EPM_JOB_ID_MISSING");
});
