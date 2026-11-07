// scripts/lib/is-main.mjs —— scripts/ 下各 CLI 入口共用的"是否被直接执行"判定（仅脚本侧使用，
// 运行时代码不 import scripts/）。
//
// 脚本既是 `node scripts/x.mjs` / `npm run x` 的入口，又会被 *.test.mjs import 单测纯函数：
// 只有被直接执行时才能跑 main，被 import 时绝不能顺带触发 SSH / 删文件 / 起子进程等副作用。
//
// 比较两侧的**文件系统真实路径**：import.meta.url 已被 Node 解析过软链，而 argv[1] 保留调用时的写法
// （经软链目录/软链文件启动时两者不等，此前会静默 exit 0）。仓库路径含中文，只比路径、不手拼 file:// 串
// （手写 `file://${path.resolve()}` 不做 percent-encode，与 import.meta.url 永不相等，入口会静默不启动）。
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isSameModulePath(argvPath, moduleUrl, { realpath = realpathSync } = {}) {
  if (!argvPath) return false;
  try {
    const modulePath = fileURLToPath(moduleUrl);
    let argvReal;
    try {
      argvReal = realpath(path.resolve(argvPath));
    } catch {
      argvReal = path.resolve(argvPath);
    }
    let moduleReal;
    try {
      moduleReal = realpath(modulePath);
    } catch {
      moduleReal = modulePath;
    }
    return argvReal === moduleReal;
  } catch {
    return false;
  }
}

// 用法：`if (isMainModule(import.meta.url)) main();`
export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  return isSameModulePath(argvPath, moduleUrl);
}
