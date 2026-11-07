// component-version.mjs —— 热更新用的数据面组件指纹（纯 Node 内置模块）。
//
// 用途：判断"新包里的 supervisor / proxy 代码是否真的变了"，只有变了才需要平滑交接；
// 没变就让它们继续跑旧进程，隧道与代理零扰动。
//   - 组件的文件集合 = 入口文件的**静态相对 import 闭包**（import/export ... from "./x"、
//     import("./x")），不含 node: 内置模块。模块放在哪个目录都不会漏算，也不会把只属于
//     控制面的模块（状态仓、路由等）算进数据面，引发不必要的交接。
//   - supervisor 入口：work/monitor/channel-supervisor.mjs；proxy 入口：work/local_http_connect_proxy.mjs。
//   - 指纹 = sha256(按相对路径排序后逐个 "路径\0内容\0") 的前 12 位十六进制。
// appRoot 在源码模式是仓库根，打包模式是 .app/Contents/Resources/app，两者目录布局一致。
// 构建脚本在打包时把结果写进 build-info.json 的 components 字段；运行中的进程在启动时
// 计算一次并冻结，之后与磁盘上新包的值比较。

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const HASH_CHARS = 12;

export const COMPONENT_ENTRIES = Object.freeze({
  supervisor: "work/monitor/channel-supervisor.mjs",
  proxy: "work/local_http_connect_proxy.mjs",
});

// 相对路径的静态 import / re-export / 动态 import("./x")。只认 ./ 或 ../ 开头的说明符，
// 查询串（?v=）剥掉。注释里偶然出现的路径若文件不存在会被跳过，不影响指纹。
const RELATIVE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"'?]+)(?:\?[^"']*)?["']/g;

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

// 从入口出发收集闭包（appRoot 相对路径，已排序）。入口本身读不到则抛错。
export async function listImportClosure(appRoot, entry, { readFileImpl = readFile } = {}) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = String(await readFileImpl(path.join(appRoot, rel), "utf8"));
    for (const match of text.matchAll(RELATIVE_IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
      if (target.startsWith("..") || seen.has(target)) continue;
      if (await isFile(path.join(appRoot, target))) queue.push(target);
    }
  }
  return [...seen].sort();
}

export async function hashFiles(appRoot, relPaths, { readFileImpl = readFile } = {}) {
  const hash = createHash("sha256");
  for (const rel of [...new Set(relPaths)].sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFileImpl(path.join(appRoot, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, HASH_CHARS);
}

// 返回 { supervisor, proxy }；任一组件读盘失败则该字段为 ""（调用方按"未知"处理，
// 未知时应当保守地认为需要交接，而不是认为相同）。
export async function computeComponentHashes(appRoot, options = {}) {
  const result = { supervisor: "", proxy: "" };
  for (const [name, entry] of Object.entries(COMPONENT_ENTRIES)) {
    try {
      result[name] = await hashFiles(appRoot, await listImportClosure(appRoot, entry, options), options);
    } catch {}
  }
  return result;
}

// 纯函数：比较运行中组件与磁盘新包，列出需要平滑交接的组件。未知（空串）一律视为需要。
export function diffComponents(running = {}, bundle = {}) {
  const out = [];
  for (const name of ["supervisor", "proxy"]) {
    const a = typeof running[name] === "string" ? running[name] : "";
    const b = typeof bundle[name] === "string" ? bundle[name] : "";
    if (!a || !b || a !== b) out.push(name);
  }
  return out;
}
