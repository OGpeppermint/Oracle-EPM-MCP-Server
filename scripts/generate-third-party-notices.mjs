import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const lockPath = path.join(root, "package-lock.json");
const outputPath = path.join(root, "THIRD_PARTY_NOTICES.md");
const licenseDirectory = path.join(root, "licenses");
const checkOnly = process.argv.includes("--check");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const licenseFamilySources = new Map([
  ["MIT.txt", "node_modules/@modelcontextprotocol/sdk/LICENSE"],
  ["Apache-2.0.txt", "node_modules/typescript/LICENSE"],
  ["BSD-2-Clause.txt", "node_modules/json-schema-typed/LICENSE.md"],
  ["BSD-3-Clause.txt", "node_modules/fast-uri/LICENSE"],
  ["ISC.txt", "node_modules/inherits/LICENSE"],
]);

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

function findLegalFiles(packageDirectory) {
  return fs.readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|notice)(?:\..*)?$/i.test(entry.name))
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));
}

const dependencies = Object.entries(lock.packages ?? {})
  .filter(([lockKey, metadata]) => lockKey.startsWith("node_modules/") && metadata.dev !== true)
  .map(([lockKey, metadata]) => {
    const packageDirectory = path.join(root, ...lockKey.split("/"));
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
    const legalFiles = findLegalFiles(packageDirectory);
    if (legalFiles.length === 0) throw new Error(`No LICENSE or NOTICE file found for ${packageMetadata.name}@${metadata.version}.`);
    return {
      name: packageMetadata.name,
      version: metadata.version,
      license: packageMetadata.license ?? metadata.license ?? "UNSPECIFIED",
      repository: typeof packageMetadata.repository === "string" ? packageMetadata.repository : packageMetadata.repository?.url,
      legalFiles: legalFiles.map((fileName) => ({
        fileName,
        text: normalizeLineEndings(fs.readFileSync(path.join(packageDirectory, fileName), "utf8")).trim(),
      })),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const licenseCounts = dependencies.reduce((counts, dependency) => {
  counts.set(dependency.license, (counts.get(dependency.license) ?? 0) + 1);
  return counts;
}, new Map());

const lines = [
  "# Third-party software notices",
  "",
  "> Generated from the production dependency entries in `package-lock.json`. Do not edit manually; run `npm run notices`.",
  "",
  `This distribution includes ${dependencies.length} production dependency packages. All third-party software remains subject to its own license.`,
  "",
  "## License summary",
  "",
  "| SPDX/license value | Packages |",
  "| --- | ---: |",
  ...[...licenseCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([license, count]) => `| ${license} | ${count} |`),
  "",
  "## Package inventory and license texts",
  "",
];

for (const dependency of dependencies) {
  lines.push(`### ${dependency.name}@${dependency.version}`, "", `- Declared license: ${dependency.license}`);
  if (dependency.repository) lines.push(`- Repository: ${dependency.repository}`);
  for (const legalFile of dependency.legalFiles) {
    lines.push("", `#### ${legalFile.fileName}`, "", "```text", legalFile.text.replaceAll("```", "` ` `"), "```", "");
  }
}

const generated = `${lines.join("\n").trim()}\n`;
const generatedLicenseFamilies = new Map(
  [...licenseFamilySources].map(([fileName, source]) => [fileName, normalizeLineEndings(fs.readFileSync(path.join(root, ...source.split("/")), "utf8"))]),
);
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? normalizeLineEndings(fs.readFileSync(outputPath, "utf8")) : "";
  const staleLicenseFiles = [...generatedLicenseFamilies].filter(([fileName, expected]) => {
    const target = path.join(licenseDirectory, fileName);
    return !fs.existsSync(target) || normalizeLineEndings(fs.readFileSync(target, "utf8")) !== expected;
  }).map(([fileName]) => fileName);
  if (current !== generated || staleLicenseFiles.length > 0) {
    console.error(`Release notices are missing or stale${staleLicenseFiles.length ? `: ${staleLicenseFiles.join(", ")}` : ""}. Run npm run notices.`);
    process.exitCode = 1;
  } else {
    console.log(`Release notices are current (${dependencies.length} production packages; ${generatedLicenseFamilies.size} license-family files).`);
  }
} else {
  fs.writeFileSync(outputPath, generated, "utf8");
  fs.mkdirSync(licenseDirectory, { recursive: true });
  for (const [fileName, text] of generatedLicenseFamilies) fs.writeFileSync(path.join(licenseDirectory, fileName), text, "utf8");
  console.log(`Generated release notices for ${dependencies.length} production packages and ${generatedLicenseFamilies.size} license families.`);
}
