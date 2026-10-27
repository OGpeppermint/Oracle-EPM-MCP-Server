/** Small XML tree used only for generated Calculation Manager and LCM documents. */
export type XmlChild = XmlNode | string;
export type XmlNode = { tag: string; attrs: Record<string, string>; children: XmlChild[] };

export function xml(tag: string, attrs: Record<string, string> = {}, ...children: XmlChild[]): XmlNode {
  return { tag, attrs, children };
}

export function add(parent: XmlNode, tag: string, attrs: Record<string, string> = {},
  ...children: XmlChild[]): XmlNode {
  const node = xml(tag, attrs, ...children);
  parent.children.push(node);
  return node;
}

export function elements(parent: XmlNode, tag: string): XmlNode[] {
  return parent.children.filter((child): child is XmlNode => typeof child !== "string" && child.tag === tag);
}

export function first(parent: XmlNode, tag: string): XmlNode | undefined {
  return elements(parent, tag)[0];
}

export function setText(parent: XmlNode, value: string): void {
  parent.children = [value];
}

export function textOf(parent: XmlNode): string {
  return parent.children.filter((child): child is string => typeof child === "string").join("");
}

export function property(parent: XmlNode, name: string, value: string): void {
  const existing = elements(parent, "property").find((node) => node.attrs.name === name);
  if (existing) { setText(existing, value); return; }
  const position = parent.children.findIndex((child) => typeof child !== "string" && child.tag !== "property");
  const node = xml("property", { name }, value);
  parent.children.splice(position < 0 ? parent.children.length : position, 0, node);
}

export function propertyValue(parent: XmlNode, name: string): string | undefined {
  const node = elements(parent, "property").find((item) => item.attrs.name === name);
  return node ? textOf(node) : undefined;
}

export function cloneXml<T extends XmlNode>(value: T): T {
  return structuredClone(value);
}

function escapeXml(value: string, attribute: boolean): string {
  let escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
  if (attribute) escaped = escaped.replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  return escaped;
}

function render(node: XmlNode, depth: number, pretty: boolean): string {
  const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeXml(value, true)}"`).join("");
  if (!node.children.length) return `<${node.tag}${attrs} />`;
  if (node.children.every((child) => typeof child === "string"))
    return `<${node.tag}${attrs}>${escapeXml(textOf(node), false)}</${node.tag}>`;
  const indentation = pretty ? "   ".repeat(depth + 1) : "";
  const separator = pretty ? "\n" : "";
  const content = node.children.map((child) => `${indentation}${typeof child === "string"
    ? escapeXml(child, false) : render(child, depth + 1, pretty)}`).join(separator);
  const endIndent = pretty ? `\n${"   ".repeat(depth)}` : "";
  return `<${node.tag}${attrs}>${separator}${content}${endIndent}</${node.tag}>`;
}

export function xmlBytes(root: XmlNode, pretty = false): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0, pretty)}`, "utf8");
}
