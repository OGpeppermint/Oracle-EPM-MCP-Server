import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { epmRequest, EpmOperationError } from "./oracle-client.js";
import { buildRuleSnapshot, type SnapshotBuild } from "./snapshot-builder.js";
import { dependencySchema, rtpSchema } from "./snapshot-validation.js";

const text = z.string();
export const createRuleInputSchema = {
  application: z.string().trim().min(1).optional().describe("Planning application. Defaults to EPM_APPLICATION."),
  planType: z.string().min(1).max(255).describe("Exact target plan type/cube name."),
  name: z.string().min(1).max(255).describe("New Calculation Manager rule name."),
  script: z.string().min(1).max(2_000_000).describe("Calc script or Groovy source text."),
  language: z.enum(["calcscript", "groovy"]).optional().describe("Defaults to calcscript."),
  description: text.optional(),
  rtps: z.array(rtpSchema).max(256).optional().describe("Explicit run-time prompt definitions referenced by the script."),
  dependencies: z.array(dependencySchema).max(128).optional().describe("Explicit Script/Template bodies referenced by the rule; these are imported too."),
};
export type CreateRuleInput = z.infer<z.ZodObject<typeof createRuleInputSchema>>;

type InteropResponse = { status?: unknown; details?: unknown; links?: unknown; jobId?: unknown };
type Stage = "snapshot" | "upload" | "extraction" | "import";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Build = (input: Record<string, unknown>) => Promise<SnapshotBuild>;
export type CreateRuleDependencies = {
  request?: Request;
  build?: Build;
  sleep?: (ms: number) => Promise<unknown>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export class CreateRuleError extends EpmOperationError {
  constructor(code: string, message: string, readonly stage: Stage,
    readonly snapshotName?: string, readonly uploadJobId?: string,
    readonly extractionJobId?: string, readonly importJobId?: string,
    readonly outcomeUncertain = false, status?: number) {
    super(code, message, status);
  }
  details() {
    return { code: this.code, message: this.message, stage: this.stage,
      snapshotName: this.snapshotName, uploadJobId: this.uploadJobId,
      extractionJobId: this.extractionJobId, importJobId: this.importJobId,
      outcomeUncertain: this.outcomeUncertain };
  }
}

function record(value: unknown, stage: Stage): InteropResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EpmOperationError("EPM_MIGRATION_FORMAT", `Oracle returned an invalid ${stage} response.`);
  return value as InteropResponse;
}

function status(value: unknown, stage: Stage): number {
  const code = record(value, stage).status;
  if (typeof code !== "number" || !Number.isInteger(code) || code < -1)
    throw new EpmOperationError("EPM_MIGRATION_FORMAT", `Oracle did not provide a valid ${stage} status.`);
  if (code > 0) {
    throw new EpmOperationError("EPM_MIGRATION_REJECTED", `Oracle rejected ${stage} (status ${code}).`);
  }
  return code;
}

function jobId(value: unknown, path: RegExp, stage: Stage): string {
  const body = record(value, stage);
  const links = Array.isArray(body.links) ? body.links : [];
  for (const item of links) {
    if (!item || typeof item !== "object" || !("href" in item) || typeof item.href !== "string") continue;
    const match = path.exec(item.href);
    if (match && /^[A-Za-z0-9_-]{1,128}$/.test(match[1])) return match[1];
  }
  if ((typeof body.jobId === "string" || typeof body.jobId === "number") &&
      /^[A-Za-z0-9_-]{1,128}$/.test(String(body.jobId))) return String(body.jobId);
  throw new EpmOperationError("EPM_JOB_ID_MISSING", `Oracle did not return a ${stage} job identifier.`);
}

async function pollJob(request: Request, family: "jobs" | "migration", id: string,
  stage: Stage, options: Required<Pick<CreateRuleDependencies, "sleep" | "pollIntervalMs" | "pollTimeoutMs">>) {
  const deadline = Date.now() + options.pollTimeoutMs;
  for (;;) {
    if (Date.now() >= deadline)
      throw new EpmOperationError("EPM_JOB_TIMEOUT", `Oracle ${stage} job did not finish before the polling deadline.`);
    const body = await request<InteropResponse>(`/interop/rest/v2/status/${family}/${encodeURIComponent(id)}`);
    if (status(body, stage) === 0) return;
    await options.sleep(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function pollingOptions(deps: CreateRuleDependencies): Required<Pick<CreateRuleDependencies, "sleep" | "pollIntervalMs" | "pollTimeoutMs">> {
  const rawTimeout = process.env.EPM_CREATE_RULE_POLL_TIMEOUT_MS;
  const configuredTimeout = rawTimeout === undefined ? 300_000 : Number(rawTimeout);
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 1_000 || configuredTimeout > 3_600_000)
    throw new EpmOperationError("EPM_POLL_CONFIG_INVALID", "EPM_CREATE_RULE_POLL_TIMEOUT_MS must be 1000–3600000.");
  return { sleep: deps.sleep ?? ((ms) => pause(ms)),
    pollIntervalMs: deps.pollIntervalMs ?? 2_000,
    pollTimeoutMs: deps.pollTimeoutMs ?? configuredTimeout };
}

export async function createRule(input: CreateRuleInput, deps: CreateRuleDependencies = {}) {
  const request = deps.request ?? epmRequest;
  const build = deps.build ?? buildRuleSnapshot;
  const application = input.application?.trim() || process.env.EPM_APPLICATION?.trim();
  if (!application) throw new CreateRuleError("EPM_APPLICATION_REQUIRED", "Provide application or configure EPM_APPLICATION.", "snapshot");
  let stage: Stage = "snapshot";
  let snapshotName: string | undefined;
  let uploadJobId: string | undefined;
  let extractionJobId: string | undefined;
  let importJobId: string | undefined;
  try {
    const options = pollingOptions(deps);
    const snapshot = await build({
      application, plan_type: input.planType, name: input.name, script: input.script,
      language: input.language ?? "calcscript", description: input.description ?? "",
      rtps: input.rtps ?? [], dependencies: input.dependencies ?? [], mode: "combined",
    });
    snapshotName = `mcp-rule-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const filename = `${snapshotName}.zip`;
    stage = "upload";
    const started = await request<InteropResponse>("/interop/rest/v2/files/upload", {
      method: "POST", body: JSON.stringify({ fileName: filename, fileSize: snapshot.bytes.length }),
    });
    status(started, stage);
    uploadJobId = jobId(started, /\/interop\/rest\/v2\/files\/upload\/([^/?#]+)/, stage);
    const chunkSize = 50 * 1024 * 1024;
    for (let offset = 0; offset < snapshot.bytes.length; offset += chunkSize) {
      const chunk = snapshot.bytes.subarray(offset, offset + chunkSize);
      const response = await request<InteropResponse>(`/interop/rest/v2/files/upload/${encodeURIComponent(uploadJobId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/octet-stream",
          "Chunk-Range": `${offset}-${offset + chunk.length - 1}` },
        body: new Uint8Array(chunk),
      });
      if (status(response, stage) !== 0)
        throw new EpmOperationError("EPM_UPLOAD_INCOMPLETE", "Oracle did not confirm the upload chunk.");
    }
    const completed = await request<InteropResponse>(`/interop/rest/v2/files/upload/${encodeURIComponent(uploadJobId)}/complete`, {
      method: "POST", body: "{}",
    });
    const extractionStatus = status(completed, stage);
    if (extractionStatus === -1) {
      extractionJobId = jobId(completed, /\/interop\/rest\/v2\/status\/jobs\/([^/?#]+)/, stage);
      stage = "extraction";
      await pollJob(request, "jobs", extractionJobId, stage, options);
    }
    stage = "import";
    const imported = await request<InteropResponse>("/interop/rest/v2/snapshots/import", {
      method: "POST", body: JSON.stringify({ snapshotName, parameters: { importUsers: false } }),
    });
    if (status(imported, stage) === -1) {
      importJobId = jobId(imported, /\/interop\/rest\/v2\/status\/migration\/([^/?#]+)/, stage);
      await pollJob(request, "migration", importJobId, stage, options);
    }
    return { stage: "import_completed" as const, application, planType: input.planType, ruleName: input.name,
      snapshotName, uploadJobId, extractionJobId, importJobId,
      snapshotSha256: snapshot.sha256, importedArtifacts: snapshot.artifacts };
  } catch (error) {
    if (error instanceof CreateRuleError) throw error;
    const code = error instanceof EpmOperationError ? error.code : "CREATE_RULE_UNEXPECTED";
    const message = error instanceof EpmOperationError ? error.message : "Rule creation failed unexpectedly.";
    const uncertain = stage !== "snapshot" && ["EPM_TIMEOUT", "EPM_ABORTED", "EPM_NETWORK_ERROR", "EPM_JOB_TIMEOUT"].includes(code);
    throw new CreateRuleError(code, message, stage, snapshotName, uploadJobId,
      extractionJobId, importJobId, uncertain, error instanceof EpmOperationError ? error.status : undefined);
  }
}
