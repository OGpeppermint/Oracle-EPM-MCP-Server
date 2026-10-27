import { z } from "zod";
import { EpmOperationError } from "./oracle-client.js";

export class SnapshotError extends EpmOperationError {
  constructor(code: string, message: string, readonly field?: string) { super(code, message); }
}

const text = z.string();
const limits = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list"), values: z.array(text).min(1).max(1024) }),
  z.strictObject({ kind: z.literal("minmax"), min: text.optional(), max: text.optional() }),
  z.strictObject({ kind: z.literal("smartlist"), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("expression"), expression: z.string().min(1) }),
]);
const cellref = z.strictObject({
  dimension: z.string().min(1), dimension_mode: z.enum(["name", "type"]).optional(),
  default_value: text.optional(), prompt_text: text.optional(),
  list_values: z.array(text).max(1024).optional(),
});
export const rtpSchema = z.strictObject({
  name: z.string().min(1).max(255), type: z.enum([
    "str", "num", "percent", "member", "members", "dimension", "cellref", "str_as_num",
    "date_as_num", "member_range", "integer",
  ]),
  scope: z.enum(["rule", "plan_type", "application", "global"]).optional(),
  dimension: z.string().min(1).optional(), dimension_mode: z.enum(["name", "type"]).optional(),
  default_value: text.optional(), prompt_text: text.optional(), description: text.optional(),
  group: text.optional(), system_default: text.optional(), validation_value: text.optional(),
  allow_missing: z.boolean().optional(), use_last_value: z.boolean().optional(),
  use_system_defaults: z.boolean().optional(), hidden: z.boolean().optional(),
  use_as_override_value: z.boolean().optional(), limits: limits.optional(),
  cellref_prompts: z.array(cellref).max(128).optional(),
});
export const dependencySchema = z.strictObject({
  kind: z.enum(["script", "template"]), name: z.string().min(1).max(255),
  script: z.string().min(1).max(2_000_000), language: z.enum(["calcscript", "groovy"]).optional(),
  description: text.optional(),
});
export type Rtp = z.infer<typeof rtpSchema>;
export type Dependency = z.infer<typeof dependencySchema>;

export const snapshotRequestSchema = z.strictObject({
  application: z.string().min(1).max(255), plan_type: z.string().min(1).max(255),
  name: z.string().min(1).max(255), script: z.string().min(1).max(2_000_000),
  language: z.enum(["calcscript", "groovy"]).default("calcscript"),
  description: text.default(""), rtps: z.array(rtpSchema).max(256).default([]),
  dependencies: z.array(dependencySchema).max(128).default([]),
  mode: z.literal("calc").default("calc"),
});
export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;

export function checkedText(value: string, label: string): string {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < 32 && point !== 9 && point !== 10 && point !== 13 ||
        point >= 0xd800 && point <= 0xdfff || point === 0xfffe || point === 0xffff)
      throw new SnapshotError("SNAPSHOT_INVALID_INPUT", `${label} contains XML control characters.`, label);
  }
  return value;
}

function invalid(message: string, field: string, code = "SNAPSHOT_INVALID_INPUT"): never {
  throw new SnapshotError(code, message, field);
}

export function validateSnapshotRequest(input: unknown): SnapshotRequest {
  const parsed = snapshotRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    invalid(`Invalid snapshot input: ${issue.message}`, `request.${issue.path.join(".")}`);
  }
  const request = parsed.data;
  const check = (value: string, path: string) => checkedText(value, path);
  check(request.application, "request.application");
  check(request.plan_type, "request.plan_type");
  check(request.name, "request.name");
  check(request.script, "request.script");
  check(request.description, "request.description");
  for (const [field, value] of [["application", request.application], ["plan_type", request.plan_type]]) {
    if (!value.trim() || value === "." || value === ".." || /[/\\\r\n\t]/.test(value))
      invalid(`Invalid ${field}.`, `request.${field}`);
  }
  const checkArtifactName = (name: string, field: string) => {
    check(name, field);
    if (!name.trim() || name === "." || name === ".." || /[\\\r\n\t]/.test(name))
      invalid("Invalid artifact name.", field);
  };
  checkArtifactName(request.name, "request.name");
  if (!request.script.trim()) invalid("Rule script cannot be blank.", "request.script");
  const seenDependencies = new Set<string>();
  for (const [index, dep] of request.dependencies.entries()) {
    const path = `request.dependencies[${index}]`;
    checkArtifactName(dep.name, `${path}.name`);
    check(dep.script, `${path}.script`);
    if (dep.description !== undefined) check(dep.description, `${path}.description`);
    if (!dep.script.trim()) invalid("Dependency script cannot be blank.", `${path}.script`);
    if (dep.language && dep.language !== request.language)
      invalid("Dependencies must use the rule language.", `${path}.language`);
    const key = `${dep.kind}\0${dep.name}`;
    if (seenDependencies.has(key)) invalid("Duplicate dependency.", path, "DUPLICATE_DEPENDENCY");
    seenDependencies.add(key);
  }
  const seenPrompts = new Set<string>();
  for (const [index, prompt] of request.rtps.entries()) {
    const path = `request.rtps[${index}]`;
    for (const [key, value] of Object.entries(prompt)) {
      if (typeof value === "string") check(value, `${path}.${key}`);
    }
    if (!prompt.name.trim() || prompt.name !== prompt.name.trim() || /[{}\r\n\t]/.test(prompt.name))
      invalid("Invalid RTP name.", `${path}.name`);
    const key = prompt.name.toLocaleLowerCase("en-US");
    if (seenPrompts.has(key)) invalid("RTP names must be unique, ignoring case.", `${path}.name`, "DUPLICATE_RTP");
    seenPrompts.add(key);
    if (["member", "members", "member_range"].includes(prompt.type) && !prompt.dimension)
      invalid("Member prompts require a dimension.", `${path}.dimension`);
    if (prompt.type === "cellref" && !prompt.cellref_prompts?.length)
      invalid("Cell-reference prompts require cellref_prompts.", `${path}.cellref_prompts`);
    if (prompt.cellref_prompts && prompt.type !== "cellref")
      invalid("cellref_prompts requires type cellref.", path);
    if (prompt.dimension_mode && !prompt.dimension)
      invalid("dimension_mode requires dimension.", path);
    if (prompt.limits?.kind === "minmax" && prompt.limits.min === undefined && prompt.limits.max === undefined)
      invalid("A minmax limit needs min or max.", `${path}.limits`);
    if (prompt.limits) {
      for (const value of Object.values(prompt.limits)) {
        if (typeof value === "string") check(value, `${path}.limits`);
        if (Array.isArray(value)) value.forEach((item) => check(item, `${path}.limits.values`));
      }
    }
    for (const row of prompt.cellref_prompts ?? []) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") check(value, `${path}.cellref_prompts`);
        if (Array.isArray(value)) value.forEach((item) => check(item, `${path}.cellref_prompts.list_values`));
      }
    }
  }
  if (request.script.length + request.dependencies.reduce((sum, dep) => sum + dep.script.length, 0) > 8_000_000)
    invalid("Total script input exceeds 8 million characters.", "request.script", "INPUT_LIMIT");
  return request;
}
