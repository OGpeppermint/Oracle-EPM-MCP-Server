import { SnapshotError, type SnapshotRequest } from "./snapshot-validation.js";

export type MacroDefinition = {
  kind: "script" | "template"; application: string; planType: string;
  name: string; body: string;
};
export type MacroIndex = Map<string, MacroDefinition>;
const macroKey = (kind: string, app: string, cube: string, name: string) =>
  `${kind}\0${app}\0${cube}\0${name}`;

type MacroCall = { start: number; end: number; kind: "script" | "template";
  args: Record<string, string> };

function macroCalls(body: string): MacroCall[] {
  const calls: MacroCall[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("//", i)) {
      const end = body.indexOf("\n", i + 2);
      i = end < 0 ? body.length : end + 1;
      continue;
    }
    if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i + 2);
      if (end < 0) throw new SnapshotError("INVALID_SCRIPT", "Unterminated block comment.");
      i = end + 2;
      continue;
    }
    if (body[i] === '"' || body[i] === "'") {
      const quote = body.slice(i, i + 3) === body[i].repeat(3) ? body[i].repeat(3) : body[i];
      i += quote.length;
      while (i < body.length) {
        if (body[i] === "\\") i += 2;
        else if (body.startsWith(quote, i)) { i += quote.length; break; }
        else i++;
      }
      continue;
    }
    const match = body[i] === "%" ? /^%(Template|Script)\s*\(/i.exec(body.slice(i)) : null;
    if (!match) { i++; continue; }
    const start = i;
    const argStart = i + match[0].length;
    let j = argStart;
    let depth = 1;
    let quote: string | undefined;
    while (j < body.length && depth) {
      const char = body[j];
      if (quote) {
        if (char === "\\") { j += 2; continue; }
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
      j++;
    }
    if (depth) throw new SnapshotError("INVALID_MACRO", "Unterminated macro call.");
    const raw = body.slice(argStart, j - 1);
    const args: Record<string, string> = {};
    const argument = /\s*([A-Za-z]+)\s*:?=\s*(["'])(.*?)\2\s*(?:,|$)/sy;
    let position = 0;
    while (position < raw.length && raw.slice(position).trim()) {
      argument.lastIndex = position;
      const attribute = argument.exec(raw);
      if (!attribute || !["name", "application", "plantype"].includes(attribute[1].toLowerCase()))
        throw new SnapshotError("UNSUPPORTED_MACRO_ARGUMENT",
          "Macro supports literal name/application/plantype only; DTP arguments are unsupported.");
      const key = attribute[1].toLowerCase();
      if (Object.hasOwn(args, key)) throw new SnapshotError("INVALID_MACRO", `Duplicate macro argument: ${key}.`);
      args[key] = attribute[3];
      position = argument.lastIndex;
    }
    if (!args.name) throw new SnapshotError("INVALID_MACRO", "Macro call needs a name.");
    calls.push({ start, end: j, kind: match[1].toLowerCase() as MacroCall["kind"], args });
    i = j;
  }
  return calls;
}

export function macroIndex(definitions: MacroDefinition[]): MacroIndex {
  const index: MacroIndex = new Map();
  for (const definition of definitions) {
    const key = macroKey(definition.kind, definition.application, definition.planType, definition.name);
    if (index.has(key)) throw new SnapshotError("DUPLICATE_DEPENDENCY", "Duplicate Script/Template dependency.");
    index.set(key, definition);
  }
  return index;
}

export function expandBody(body: string, app: string, cube: string,
  index: MacroIndex, stack: string[] = []): string {
  if (stack.length > 100) throw new SnapshotError("MACRO_DEPTH", "Macro nesting exceeds 100 levels.");
  const parts: string[] = [];
  let cursor = 0;
  let length = 0;
  for (const call of macroCalls(body)) {
    const application = call.args.application ?? app;
    const planType = call.args.plantype ?? cube;
    const key = macroKey(call.kind, application, planType, call.args.name);
    if (stack.includes(key)) throw new SnapshotError("CYCLIC_MACRO", `Cyclic macro reference: ${call.args.name}.`);
    const definition = index.get(key);
    if (!definition) throw new SnapshotError("MISSING_MACRO", `Missing ${call.kind}: ${call.args.name}.`);
    let expanded = expandBody(definition.body, application, planType, index, [...stack, key]);
    if (call.kind === "template") {
      const label = `${application}.${planType}.${call.args.name}`.replace(/\*\//g, "* /");
      expanded = `/* Start Template:${label}*/\n${expanded}\n/* End Template:${label}*/`;
    }
    length += call.start - cursor + expanded.length;
    if (length > 8_000_000) throw new SnapshotError("EXPANSION_LIMIT", "Expanded script exceeds 8 million characters.");
    parts.push(body.slice(cursor, call.start), expanded);
    cursor = call.end;
  }
  length += body.length - cursor;
  if (length > 8_000_000) throw new SnapshotError("EXPANSION_LIMIT", "Expanded script exceeds 8 million characters.");
  parts.push(body.slice(cursor));
  return parts.join("");
}

function scanComments(body: string): { code: string; blocks: Array<{ position: number; text: string }> } {
  const output: string[] = [];
  const blocks: Array<{ position: number; text: string }> = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("//", i)) {
      const end = body.indexOf("\n", i + 2);
      const j = end < 0 ? body.length : end;
      output.push(" ".repeat(j - i));
      i = j;
    } else if (body.startsWith("/*", i)) {
      const j = body.indexOf("*/", i + 2);
      if (j < 0) throw new SnapshotError("INVALID_SCRIPT", "Unterminated block comment.", "request.script");
      blocks.push({ position: i, text: body.slice(i + 2, j) });
      output.push(body.slice(i, j + 2).replace(/[^\n]/g, " "));
      i = j + 2;
    } else if (body[i] === '"' || body[i] === "'") {
      const quote = body.slice(i, i + 3) === body[i].repeat(3) ? body[i].repeat(3) : body[i];
      const start = i;
      i += quote.length;
      while (i < body.length) {
        if (body[i] === "\\") i += 2;
        else if (body.startsWith(quote, i)) { i += quote.length; break; }
        else i++;
      }
      output.push(body.slice(start, i));
    } else output.push(body[i++]);
  }
  return { code: output.join(""), blocks };
}

export function validateBindings(request: SnapshotRequest, effectiveBody: string): void {
  let { code, blocks } = scanComments(effectiveBody);
  if (request.language === "groovy") {
    const headers = blocks.map((block) => ({ position: block.position,
      match: /^\s*RTPS\s*:(.*)/is.exec(block.text) })).filter((entry) => entry.match);
    if (headers.length > 1)
      throw new SnapshotError("INVALID_RTP_HEADER", "Only one RTPS header is supported.", "request.script");
    if (!headers.length) code = "";
    else {
      if ((request.script.slice(0, headers[0].position).match(/\n/g) ?? []).length >= 25)
        throw new SnapshotError("INVALID_RTP_HEADER", "RTPS header must start in the first 25 lines.", "request.script");
      code = headers[0].match![1];
      if (code.replace(/\{[^{}]+\}|[\s,]/g, ""))
        throw new SnapshotError("INVALID_RTP_HEADER", "RTPS header requires {PromptName} entries.", "request.script");
    }
  }
  const used = new Set<string>();
  for (const match of code.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1].trim();
    if (name) used.add(name.toLocaleLowerCase("en-US"));
  }
  const defined = new Set(request.rtps.map((prompt) => prompt.name.toLocaleLowerCase("en-US")));
  const missing = [...used].filter((name) => !defined.has(name));
  const unused = [...defined].filter((name) => !used.has(name));
  if (missing.length) throw new SnapshotError("MISSING_RTP", `Missing RTP definitions: ${missing.sort().join(", ")}.`, "request.rtps");
  if (unused.length) throw new SnapshotError("UNUSED_RTP", `RTP definitions not referenced by the rule: ${unused.sort().join(", ")}.`, "request.rtps");
}
