import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "packages", "adapter-utils");
const distRoot = path.join(packageRoot, "dist", "acpx-engine");
const licenseFiles = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md", "COPYING"];

// TypeScript writes runtime.js first. Replace it with a bundle resolved from
// the repository's patched ACPX install, while leaving runtime.d.ts intact.
const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(packageRoot, "src", "acpx-engine", "runtime.ts")],
  outfile: path.join(distRoot, "runtime.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});

// The runtime bundle includes ACPX and its npm dependencies. Ship their
// license texts beside it; all package inputs must have a notice.
const dependencies = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = path.dirname(path.resolve(repoRoot, input));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest.name && manifest.version) {
        if (manifest.name !== "@paperclipai/adapter-utils") {
          dependencies.set(`${manifest.name}@${manifest.version}`, directory);
        }
        break;
      }
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [name, directory] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
  const license = licenseFiles.find((file) => existsSync(path.join(directory, file)));
  if (!license) throw new Error(`Bundled dependency ${name} has no license file`);
  notices.push(`===== ${name} =====\n${(await fs.readFile(path.join(directory, license), "utf8")).trim()}\n`);
}
await fs.writeFile(path.join(distRoot, "THIRD_PARTY_LICENSES.txt"), notices.join("\n"));
// tsc produced a map for its placeholder runtime.js; it no longer matches.
await fs.rm(path.join(distRoot, "runtime.js.map"), { force: true });
