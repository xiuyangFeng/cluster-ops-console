// 从经过白名单与敏感信息扫描的 Windows resources/app 生成小更新包。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodePackageBundle, packageAssetName } from "../work/monitor/lib/self-update/package-bundle.mjs";

export function buildUpdatePackage({ resourcesApp, outDir, arch }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(resourcesApp, "package.json"), "utf8"));
  const files = [];
  function walk(dir, prefix = "") {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`更新包不能包含链接：${rel}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else files.push({ path: rel, data: fs.readFileSync(path.join(dir, e.name)).toString("base64") });
    }
  }
  walk(resourcesApp);
  const bytes = encodePackageBundle({ schema: 1, version: pkg.version, electron: pkg.devDependencies.electron, platform: `win32-${arch}`, files });
  const name = packageAssetName(pkg.version, arch);
  fs.writeFileSync(path.join(outDir, name), bytes);
  fs.writeFileSync(path.join(outDir, `${name}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  return name;
}
