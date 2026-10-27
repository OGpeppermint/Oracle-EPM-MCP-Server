import { add, elements, first, property, propertyValue, xml, type XmlNode } from "./snapshot-xml.js";
import { SnapshotError, type Rtp, type SnapshotRequest } from "./snapshot-validation.js";

const typeCodes: Record<Rtp["type"], string> = {
  str: "0", num: "1", percent: "2", member: "3", members: "4", dimension: "5",
  cellref: "7", str_as_num: "10", date_as_num: "11", member_range: "13", integer: "18",
};

function valueText(value: string | number | boolean): string {
  return typeof value === "boolean" ? String(value).toLowerCase() : String(value);
}

function properties(node: XmlNode, values: Record<string, string | number | boolean | undefined>): void {
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value !== undefined) property(node, key, valueText(value));
  }
}

function addLimits(parent: XmlNode, limits: NonNullable<Rtp["limits"]>): void {
  const node = add(parent, "limits", { type: limits.kind });
  switch (limits.kind) {
    case "list": properties(node, { value: limits.values.join(",") }); break;
    case "minmax": properties(node, { min: limits.min, max: limits.max }); break;
    case "smartlist": properties(node, { name: limits.name }); break;
    case "expression": properties(node, { value: limits.expression }); break;
  }
}

export function composeRtps(root: XmlNode, rule: XmlNode, request: SnapshotRequest): void {
  if (!request.rtps.length) return;
  const variables = first(root, "variables")!;
  const references = xml("variable_references");
  const position = rule.children.findIndex((child) => typeof child !== "string" && child.tag !== "property");
  rule.children.splice(position < 0 ? rule.children.length : position, 0, references);
  for (const [index, prompt] of request.rtps.entries()) {
    const identity = String(index + 1);
    const variable = add(variables, "variable", {
      id: identity, name: prompt.name, type: prompt.type, usage: "const", product: "Planning",
    });
    const scope = prompt.scope ?? "rule";
    if (prompt.description !== undefined) property(variable, "description", prompt.description);
    if (scope !== "global") property(variable, "application", request.application);
    if (scope === "rule" || scope === "plan_type") property(variable, "plantype", request.plan_type);
    const values: Record<string, string | number | boolean | undefined> = { scope: "ruleset" };
    if (scope === "rule") values.rule_name = request.name;
    if (prompt.dimension !== undefined) {
      const mode = prompt.dimension_mode ?? "name";
      values[mode === "type" ? "dimensionType" : "dimension"] = prompt.dimension;
      values.dimensionInputMode = mode;
    }
    values.prompt_text = prompt.prompt_text;
    values.group = prompt.group;
    values.allowMissing = prompt.allow_missing;
    values.systemDefault = prompt.system_default;
    values.useLastValue = prompt.use_last_value;
    values.useSystemDefaults = prompt.use_system_defaults;
    properties(variable, values);
    add(variable, "value", {}, prompt.default_value ?? "");
    if (prompt.limits) addLimits(variable, prompt.limits);
    if (prompt.cellref_prompts) {
      const rows = add(variable, "cellref_prompts");
      for (const [rowIndex, row] of prompt.cellref_prompts.entries()) {
        const child = add(rows, "cellref_prompt", { id: String(rowIndex + 1) });
        if (row.prompt_text !== undefined) property(child, "prompt_text", row.prompt_text);
        const dimension = add(child, "dimension", { [row.dimension_mode ?? "name"]: row.dimension });
        if (row.default_value !== undefined) add(add(dimension, "expression"), "user_inp", {}, row.default_value);
        if (row.list_values !== undefined) addLimits(child, { kind: "list", values: row.list_values });
      }
    }
    const reference = add(references, "variable_reference", { name: prompt.name, id: identity });
    properties(reference, {
      hidden: prompt.hidden ?? false,
      rule_name: request.name,
      seq: index + 1,
      type: typeCodes[prompt.type],
      useAsOverrideValue: prompt.use_as_override_value ?? false,
      value: prompt.default_value,
      validation_value: prompt.validation_value,
      group: prompt.group,
      allowMissing: prompt.allow_missing,
    });
  }
}

export function verifyRtps(root: XmlNode, rule: XmlNode, request: SnapshotRequest): void {
  const definitions = elements(first(root, "variables")!, "variable");
  const references = first(rule, "variable_references");
  const refs = references ? elements(references, "variable_reference") : [];
  if (definitions.length !== request.rtps.length || refs.length !== request.rtps.length)
    throw new SnapshotError("RTP_ROUND_TRIP", "RTP XML count mismatch.");
  for (const [index, prompt] of request.rtps.entries()) {
    const definition = definitions[index];
    const reference = refs[index];
    const identity = String(index + 1);
    if (definition.attrs.name !== prompt.name || reference.attrs.name !== prompt.name ||
        definition.attrs.id !== identity || reference.attrs.id !== identity ||
        definition.attrs.type !== prompt.type || propertyValue(reference, "type") !== typeCodes[prompt.type] ||
        propertyValue(reference, "seq") !== identity)
      throw new SnapshotError("RTP_ROUND_TRIP", "RTP XML reference mismatch.");
  }
}
