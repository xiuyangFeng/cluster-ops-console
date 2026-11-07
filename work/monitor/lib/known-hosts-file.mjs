// 用户自己的 ~/.ssh/known_hosts：把核对过的主机密钥行去重追加进去。
// 原在 scripts/setup/host-keys.mjs，抽到 lib 供命令行向导与 App 内接入引导共用；向导仍从原处 re-export。
//
// 只追加、不重写（v2.64）。这份文件是用户自己的：可能有几百行别处来的记录，也可能是指向别处（dotfiles 仓库）的软链接。
//   - 只有「文件不存在」（ENOENT）当空文件。别的读错误（没权限、是个目录、I/O 出错）原样报出来、一个字节都不写——
//     以前一律当空文件再整份重写，读不出来的那一次会用新的几行把原有内容整个盖掉。
//   - 写入是追加（O_APPEND）：只写新增的行；原文件末尾没有换行时先补一个，免得新行粘在最后一行后面。
//     追加顺着软链接写进它指向的文件，链接本身不动；新建的文件是 0600，已有文件的权限不改。
//   - 去重按整行（去掉首尾空白）比：文件里已有的不再写，这次给的行里重复的也只写一次。
import nodeFs from "node:fs";
import path from "node:path";

// 读或写失败：message 给人看（不含文件内容），code 区分是哪一步，cause 是原始错误（带 errno 代号）。
export class KnownHostsWriteError extends Error {
  constructor(message, { code, cause }) {
    super(message, { cause });
    this.name = "KnownHostsWriteError";
    this.code = code;
    this.errno = cause?.code || null;
  }
}

export function appendKnownHosts(filePath, lines, {
  mkdirSync = nodeFs.mkdirSync,
  readFileSync = nodeFs.readFileSync,
  appendFileSync = nodeFs.appendFileSync,
} = {}) {
  let current = "";
  let exists = true;
  try {
    current = String(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new KnownHostsWriteError(`读不出 ${filePath}（${error?.code || error?.message || "未知错误"}），为免覆盖原有内容，没有写入`, { code: "known-hosts-unreadable", cause: error });
    }
    exists = false;
  }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const added = [];
  for (const raw of lines || []) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line || existing.has(line)) continue;
    existing.add(line);
    added.push(line);
  }
  if (!added.length) return { added: 0 };
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  try {
    if (!exists) mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // mode 只在新建文件时生效；已有文件（含软链接指向的文件）的权限不动。
    appendFileSync(filePath, `${separator}${added.join("\n")}\n`, { mode: 0o600 });
  } catch (error) {
    throw new KnownHostsWriteError(`写不进 ${filePath}（${error?.code || error?.message || "未知错误"}）`, { code: "known-hosts-write-failed", cause: error });
  }
  return { added: added.length };
}

// ssh-keygen -F 查询用的主机名：非 22 端口在 known_hosts 里记作 [host]:port。
export function knownHostsLookupName(hostName, port) {
  return Number(port) === 22 || port == null ? String(hostName) : `[${hostName}]:${port}`;
}
