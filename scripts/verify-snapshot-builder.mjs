import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildRuleSnapshot } from "../dist/snapshot-builder.js";

function entries(zip) {
  const files = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const packed = zip.readUInt32LE(offset + 18);
    const original = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const payload = zip.subarray(start, start + packed);
    const decoded = method === 8 ? inflateRawSync(payload) : payload;
    assert.equal(decoded.length, original);
    files.set(name, decoded.toString("utf8"));
    offset = start + packed;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  return files;
}

const base = { application: "APP|X", plan_type: "Plan:1", name: "Rule/%|",
  script: '"Account" = 1;', language: "calcscript", rtps: [], dependencies: [], mode: "calc" };

test("TypeScript builder packages a deterministic CALC snapshot and encodes special characters", async () => {
  const first = await buildRuleSnapshot(base);
  const second = await buildRuleSnapshot(base);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, createHash("sha256").update(first.bytes).digest("hex"));
  assert.equal(first.entryCount, 6);
  const files = entries(first.bytes);
  const path = "CALC-Calculation Manager/resource/Planning/APP|X/Plan:1/Rules/Rule%2F%25%7C";
  assert.ok(files.has(path));
  assert.match(files.get(path), /<rule id="1" name="Rule\/%\|" product="Planning">/);
  assert.match(files.get("Import.xml"), /pattern="Rule\/%\|"/);
  assert.match(files.get("CALC-Calculation Manager/info/sourceInfo.xml"), /<Product>CALC<\/Product>/);
});

test("RTPs and explicit dependencies appear in the rule envelope and manifests", async () => {
  const snapshot = await buildRuleSnapshot({ ...base, name: "Allocate",
    script: '%Script(name:="Settings")\nFIX({Scenario})\n"Allocated" = "Expense";\nENDFIX',
    rtps: [{ name: "Scenario", type: "member", dimension: "Scenario", default_value: "Actual" }],
    dependencies: [{ kind: "script", name: "Settings", script: "SET UPDATECALC OFF;" }],
  });
  assert.equal(snapshot.artifacts.length, 2);
  const files = entries(snapshot.bytes);
  assert.equal(files.size, 7);
  const rule = files.get("CALC-Calculation Manager/resource/Planning/APP|X/Plan:1/Rules/Allocate");
  assert.match(rule, /<variable id="1" name="Scenario" type="member"/);
  assert.match(rule, /<variable_reference name="Scenario" id="1">/);
  assert.match(rule, /<component id="2" name="Settings" product="Planning" type="script">/);
  assert.match(rule, /%Script\(name:="Settings"\)/);
  assert.match(files.get("Import.xml"), /pattern="Settings"/);
});

test("combined LCM snapshot includes Calculation Manager authoring and Planning rule artifacts", async () => {
  const snapshot = await buildRuleSnapshot({ ...base, mode: "combined", name: "Allocate",
    script: '%Script(name:="Settings")\n"Allocated" = 1;',
    dependencies: [{ kind: "script", name: "Settings", script: "SET UPDATECALC OFF;" }],
  });
  const files = entries(snapshot.bytes);
  const authoring = files.get("CALC-Calculation Manager/resource/Planning/APP|X/Plan:1/Rules/Allocate");
  const planning = files.get("HP-APP|X/resource/Cube/Plan:1/Calculation Manager Rules/Allocate.xml");
  assert.match(authoring, /%Script\(name:="Settings"\)/);
  assert.match(planning, /SET UPDATECALC OFF;/);
  assert.doesNotMatch(planning, /%Script\(name:="Settings"\)/);
  assert.match(files.get("HP-APP|X/info/sourceInfo.xml"), /<Product>HP<\/Product>/);
  assert.match(files.get("Import.xml"), /product="CALC"/);
  assert.match(files.get("Import.xml"), /product="HP"/);
  assert.equal(files.size, 11);
});

test("semantic input errors fail before any ZIP is created", async () => {
  await assert.rejects(buildRuleSnapshot({ ...base, script: "FIX({Missing}) ENDFIX" }),
    (error) => error.code === "MISSING_RTP");
  await assert.rejects(buildRuleSnapshot({ ...base, script: '%Script(name:="Missing")' }),
    (error) => error.code === "MISSING_MACRO");
  await assert.rejects(buildRuleSnapshot({ ...base, plan_type: "../Other" }),
    (error) => error.code === "SNAPSHOT_INVALID_INPUT");
  await assert.rejects(buildRuleSnapshot({ ...base,
    dependencies: [{ kind: "script", name: "Cycle", script: '%Script(name:="Cycle")' }] }),
    (error) => error.code === "CYCLIC_MACRO");
});

test("Groovy RTP header requires matching definitions", async () => {
  const snapshot = await buildRuleSnapshot({ ...base, language: "groovy",
    script: "/*RTPS: {Scenario}*/\nprintln(Scenario)",
    rtps: [{ name: "Scenario", type: "str" }] });
  assert.equal(snapshot.artifacts.length, 1);
  await assert.rejects(buildRuleSnapshot({ ...base, language: "groovy",
    script: "/*RTPS: {Scenario}*/\nprintln(Scenario)" }),
    (error) => error.code === "MISSING_RTP");
});
