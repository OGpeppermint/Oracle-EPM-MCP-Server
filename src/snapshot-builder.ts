import { createHash } from "node:crypto";
import { EpmOperationError } from "./oracle-client.js";
import { expandBody, macroIndex, validateBindings } from "./snapshot-macros.js";
import { buildFiles, createArtifact, embedDependencies } from "./snapshot-packaging.js";
import { composeRtps, verifyRtps } from "./snapshot-rtp.js";
import { validateSnapshotRequest, type SnapshotRequest } from "./snapshot-validation.js";
import { zipBytes } from "./snapshot-zip.js";

export type SnapshotBuild = {
  bytes: Buffer;
  sha256: string;
  filename: string;
  artifacts: Array<{ kind: string; application: string; plan_type: string; name: string }>;
  entryCount: number;
};

/** Build the authoring and Planning LCM artifacts in memory. Oracle I/O belongs to createRule. */
export async function buildRuleSnapshot(input: Record<string, unknown>): Promise<SnapshotBuild> {
  const request: SnapshotRequest = validateSnapshotRequest(input);
  const dependencies = request.dependencies.map((dependency, index) => createArtifact(
    dependency.kind, dependency.name, request.application, request.plan_type,
    dependency.script, dependency.language ?? request.language, dependency.description ?? "",
    String(index + 2),
  ));
  const index = macroIndex(dependencies.map((dependency) => ({
    kind: dependency.kind as "script" | "template", application: dependency.application,
    planType: dependency.planType, name: dependency.name, body: dependency.body,
  })));
  for (const dependency of dependencies)
    expandBody(dependency.body, dependency.application, dependency.planType, index,
      [`${dependency.kind}\0${dependency.application}\0${dependency.planType}\0${dependency.name}`]);
  const effectiveBody = expandBody(request.script, request.application, request.plan_type, index);
  validateBindings(request, effectiveBody);
  const rule = createArtifact("rule", request.name, request.application, request.plan_type,
    request.script, request.language, request.description);
  composeRtps(rule.root, rule.element, request);
  embedDependencies(rule, dependencies);
  verifyRtps(rule.root, rule.element, request);
  const artifacts = [...dependencies, rule];
  const files = buildFiles(request, artifacts, effectiveBody);
  const bytes = zipBytes(files);
  if (bytes.length > 32 * 1024 * 1024)
    throw new EpmOperationError("SNAPSHOT_OUTPUT_LIMIT", "Generated snapshot exceeds the supported size.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes, sha256, filename: `rule-snapshot-${sha256.slice(0, 20)}.zip`,
    artifacts: artifacts.map((artifact) => ({ kind: artifact.kind,
      application: artifact.application, plan_type: artifact.planType, name: artifact.name })),
    entryCount: files.size,
  };
}
