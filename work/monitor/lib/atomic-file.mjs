// 私有文件的原子写：目录 0700、文件 0600，写临时文件再 rename，失败时清掉临时文件。
// 凭据库、主机密钥、vault 端点、个人配置共用这一份实现。fs 可注入（测试用）。
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import path from "node:path";

export function writePrivateFileAtomicSync(filePath, body, {
  fs = nodeFs,
  now = Date.now,
  pid = process.pid,
  // 开发模式下目录可能是用户的仓库根：只建目录、不改已有目录权限时传 false。
  chmodDir = true,
} = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (chmodDir) {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const tmpPath = `${filePath}.tmp.${pid}.${now()}`;
  try {
    fs.writeFileSync(tmpPath, body, { mode: 0o600 });
    try { fs.chmodSync(tmpPath, 0o600); } catch {}
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return filePath;
}

// 异步版（运行快照 / 控制信箱 / 事件存储共用）：同目录唯一临时文件（0600）+ rename，
// 失败清掉临时文件。不建目录——目录由调用方负责。fs 可注入（node:fs/promises 形状：
// writeFile / rename / unlink）。序号保证同进程同一毫秒并发写同一目标也不共用临时文件。
let asyncTmpSeq = 0;
export async function writeFileAtomic(filePath, body, { fs = nodeFsPromises, now = Date.now, pid = process.pid } = {}) {
  const tmpPath = `${filePath}.tmp.${pid}.${now()}.${++asyncTmpSeq}`;
  try {
    await fs.writeFile(tmpPath, body, { mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch {}
    throw err;
  }
  return filePath;
}
