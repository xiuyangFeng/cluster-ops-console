// npm run package:colleague -- [output-directory]
// Explicit source allowlist + artifact secret scan; never copy personal config, runtime or installed credentials.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scanRelease } from "./release-scan.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { createZip } from "./lib/zip.mjs";

const FILES = ["package.json", "package-lock.json", "config.json", "LICENSE", ".nvmrc", "start-console.cmd", "start.sh",
  "install/install-workbench.cmd", "install/install-workbench.sh", "install/diagnose-workbench.cmd", "install/开始使用.html",
  "scripts/launch.mjs", "scripts/setup-wizard.mjs", "scripts/setup-undo.mjs", "scripts/setup", "scripts/lib", "work/local_http_connect_proxy.mjs"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function packageColleague({ rootDir, outputDir }) {
  const version = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid version");
  fs.mkdirSync(outputDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outputDir, ".colleague-stage-"));
  const names = [];
  const copy = rel => {
    const source = path.join(rootDir, rel), stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Cannot package symlink: ${rel}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source).sort()) {
        if (["runtime", "logs", "node_modules", ".git", ".DS_Store"].includes(name) || /\.test\.mjs$|\.(?:log|pid)(?:\.|$)/.test(name)) continue;
        copy(`${rel}/${name}`);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Cannot package non-file: ${rel}`);
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = fs.readFileSync(source);
    // Normalize batch copies as CRLF, even when packaging from an LF-only source checkout.
    fs.writeFileSync(dest, rel.endsWith(".cmd") ? data.toString("utf8").replace(/\r?\n/g, "\r\n") : data, { mode: stat.mode });
    names.push(rel);
  };
  try {
    for (const rel of FILES) copy(rel);
    copy("work/monitor");
    fs.copyFileSync(path.join(stage, "install/开始使用.html"), path.join(stage, "先看这里.html"));
    names.push("先看这里.html");
    const scan = scanRelease({ artifactDir: stage });
    if (!scan.ok) throw new Error(`Distribution scan failed: ${JSON.stringify(scan.findings)}`);
    const files = names.sort().map(name => ({ path: name, sha256: sha256(fs.readFileSync(path.join(stage, name))) }));
    fs.writeFileSync(path.join(stage, "bundle-manifest.json"), `${JSON.stringify({ version, files }, null, 2)}\n`);
    names.push("bundle-manifest.json");
    const folder = `cluster-workbench-${version}`;
    const bytes = createZip(names.map(name => ({ name: `${folder}/${name}`, data: fs.readFileSync(path.join(stage, name)), mode: fs.statSync(path.join(stage, name)).mode })));
    const zip = path.join(outputDir, `${folder}-windows.zip`);
    fs.writeFileSync(zip, bytes);
    fs.writeFileSync(`${zip}.sha256`, `${sha256(bytes)}  ${path.basename(zip)}\n`);
    return { version, zip, bytes: bytes.length, files: names.length, scanPassed: true, includesNode: false };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (isMainModule(import.meta.url)) {
  const rootDir = path.resolve(import.meta.dirname, "..");
  console.log(JSON.stringify(packageColleague({ rootDir, outputDir: path.resolve(process.argv[2] || path.join(rootDir, "dist/colleagues")) }), null, 2));
}
