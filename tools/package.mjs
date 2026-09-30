// Builds dist/sweep-photos-<version>.zip for "Load unpacked", a GitHub release or the Chrome Web Store.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_FILES } from "./runtime-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
const stage = path.join(dist, "sweep-photos");
const zip = path.join(dist, `sweep-photos-${version}.zip`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const entry of RUNTIME_FILES) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
for (const junk of [".DS_Store"]) {
  for (const file of fs.readdirSync(stage, { recursive: true })) {
    if (path.basename(file) === junk) fs.rmSync(path.join(stage, file));
  }
}
execFileSync("zip", ["-qrX", zip, "."], { cwd: stage });
console.log(`${path.relative(root, zip)} (${Math.round(fs.statSync(zip).size / 1024)} KB)`);
