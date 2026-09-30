// Static checks that don't need Chrome: manifest references, syntax, imports and versions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_FILES } from "./runtime-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));

const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
if (manifest.version !== pkg.version) problems.push(`manifest.json ${manifest.version} ≠ package.json ${pkg.version}`);

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
];
for (const file of referenced) {
  if (!exists(file)) problems.push(`manifest.json refers to missing ${file}`);
  if (!RUNTIME_FILES.some((entry) => file === entry || file.startsWith(`${entry}/`))) problems.push(`${file} isn't in tools/runtime-files.mjs, so it wouldn't be packaged`);
}

const runtimeJs = RUNTIME_FILES.flatMap((entry) => {
  const full = path.join(root, entry);
  if (fs.statSync(full).isDirectory()) return fs.readdirSync(full, { recursive: true }).map((file) => path.join(entry, file));
  return [entry];
});
for (const file of runtimeJs.filter((name) => /\.m?js$/.test(name))) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
  } catch (error) {
    problems.push(`${file}: ${String(error.stderr).trim().split("\n").slice(0, 5).join(" ")}`);
  }
  for (const [, spec] of read(file).matchAll(/(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    if (!exists(path.join(path.dirname(file), spec))) problems.push(`${file} imports missing ${spec}`);
  }
}
for (const html of runtimeJs.filter((name) => name.endsWith(".html"))) {
  for (const [, ref] of read(html).matchAll(/(?:src|href)="([^":]+)"/g)) {
    if (!exists(path.join(path.dirname(html), ref))) problems.push(`${html} refers to missing ${ref}`);
  }
}

if (problems.length) {
  console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${runtimeJs.length} runtime files, manifest ${manifest.version}`);
