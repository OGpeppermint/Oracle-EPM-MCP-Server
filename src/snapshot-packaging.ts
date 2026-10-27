import { add, cloneXml, property, propertyValue, xml, xmlBytes, type XmlNode } from "./snapshot-xml.js";
import { SnapshotError, type SnapshotRequest } from "./snapshot-validation.js";

export type ArtifactKind = "rule" | "script" | "template";
export type Artifact = { kind: ArtifactKind; name: string; application: string; planType: string;
  body: string; root: XmlNode; element: XmlNode };
const folderNames: Record<ArtifactKind, string> = {
  rule: "Rules", script: "Scripts", template: "Templates",
};
const elementNames: Record<ArtifactKind, [string, string]> = {
  rule: ["rules", "rule"], script: ["components", "component"],
  template: ["templates", "template"],
};

export function createArtifact(kind: ArtifactKind, name: string, application: string, planType: string,
  script: string, language: SnapshotRequest["language"], description = "", identity = "1"): Artifact {
  const root = xml("HBRRepo");
  const containers = new Map<string, XmlNode>();
  for (const tag of ["variables", "rulesets", "rules", "components", "templates"])
    containers.set(tag, add(root, tag));
  const [containerName, tag] = elementNames[kind];
  const attrs: Record<string, string> = { id: identity, name, product: "Planning" };
  if (kind === "script") attrs.type = "script";
  const element = add(containers.get(containerName)!, tag, attrs);
  property(element, "application", application);
  property(element, "plantype", planType);
  if (description) property(element, "description", description);
  add(element, "script", { type: language }, script);
  return { kind, name, application, planType, body: script, root, element };
}

export function embedDependencies(rule: Artifact, dependencies: Artifact[]): void {
  for (const dependency of dependencies) {
    const [containerName] = elementNames[dependency.kind];
    const container = rule.root.children.find((item): item is XmlNode =>
      typeof item !== "string" && item.tag === containerName)!;
    container.children.push(cloneXml(dependency.element));
  }
}

export function resourceName(name: string): string {
  return name.replace(/%/g, "%25").replace(/:/g, "%3A")
    .replace(/\//g, "%2F").replace(/\|/g, "%7C");
}

type Endpoint = Record<string, string>;
type Item = { artifact: Artifact; folder: string };
type Task = { source: Endpoint; target: Endpoint; items: Item[] };

function packageXml(tasks: Task[], provenance: boolean): Buffer {
  const root = xml("Package");
  add(root, "LOCALE", {}, "en_US");
  add(root, "User", { name: "", password: "" });
  if (provenance) {
    for (const tag of ["ExportedVersion", "ExportedDateUTC", "ExportedTimeUTC",
      "ExportedBy", "IDMDomain", "ServiceInstance"]) add(root, tag);
  }
  for (const task of tasks) {
    const node = add(root, "Task");
    add(node, "Source", task.source);
    add(node, "Target", task.target);
    for (const { artifact, folder } of task.items)
      add(node, "Artifact", { recursive: "false", parentPath: folder, pattern: artifact.name });
  }
  return xmlBytes(root, true);
}

function sourceInfo(): Buffer {
  const root = xml("sourceInfo");
  const values = {
    Application: "CalcApp", Product: "CALC", ProductVersion: "11.1.2.3",
    Project: "Foundation", usesFriendlyNames: "false", metadataFileSupported: "false",
    groupingSupported: "true", LCMVersion: "11.1.2",
  };
  for (const [key, value] of Object.entries(values)) add(root, key, {}, value);
  return xmlBytes(root, true);
}

export function buildFiles(request: SnapshotRequest, artifacts: Artifact[]): Map<string, Buffer> {
  const category = "CALC-Calculation Manager";
  const target: Endpoint = { type: "Application", product: "CALC", project: "Foundation",
    application: "Calculation Manager" };
  const filesystem: Endpoint = { type: "FileSystem", filePath: `/${category}` };
  const files = new Map<string, Buffer>();
  const listing = xml("artifactListing");
  const folderSet = new Set<string>();
  const items: Item[] = [];
  for (const artifact of artifacts) {
    const folder = `/Planning/${artifact.application}/${artifact.planType}/${folderNames[artifact.kind]}`;
    items.push({ artifact, folder });
    const parts = folder.slice(1).split("/");
    for (let n = 1; n <= parts.length; n++) folderSet.add(`/${parts.slice(0, n).join("/")}`);
    const path = `${category}/resource${folder}/${resourceName(artifact.name)}`;
    if (files.has(path)) throw new SnapshotError("RESOURCE_COLLISION", `Resource collision: ${path}.`);
    files.set(path, xmlBytes(artifact.root));
    add(listing, "resource", {
      name: artifact.name, id: artifact.name,
      type: artifact.kind.charAt(0).toUpperCase() + artifact.kind.slice(1), cloneOnly: "false",
      size: "", path: folder, pathAlias: folder, modifiedBy: "", lastUpdated: "",
      description: propertyValue(artifact.element, "description") ?? "",
    });
  }
  for (const folder of [...folderSet].sort())
    add(listing, "folder", { name: folder.slice(folder.lastIndexOf("/") + 1), type: "Folder",
      size: "", id: "", path: folder, pathAlias: "", modifiedBy: "", lastUpdated: "", description: "" });
  files.set(`${category}/Import.xml`, packageXml([{
    source: { type: "FileSystem", filePath: "/" }, target, items,
  }], true));
  files.set(`${category}/info/sourceInfo.xml`, sourceInfo());
  files.set(`${category}/info/listing.xml`, xmlBytes(listing, true));
  files.set("Export.xml", packageXml([{ source: target, target: filesystem, items }], false));
  files.set("Import.xml", packageXml([{ source: filesystem, target, items }], true));
  return files;
}
