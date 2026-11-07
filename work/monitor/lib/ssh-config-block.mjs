// ~/.ssh/config 里单个 Host 段的读写（纯函数）。原在 scripts/setup/ssh-config.mjs，抽到 lib 供
// 命令行向导与 App 内接入引导（lib/onboarding-guide/）共用同一套实现；向导仍从原处 re-export。
//
// upsert = 剥旧段 + 末尾追加新段，幂等；调用方拿到完整新内容后整份原子写回。

// 由 upsertSshConfigBlock 写入的 Host 段固定带这行注释（不含时间戳，保证幂等：内容不随调用时间变化）。
export const MANAGED_HOST_COMMENT = "# Managed by Codex Tunnel Monitor Setup Wizard";

// 剥离 content 中名为 hostAlias 的 Host 段（该 Host 行本身 + 其后所有缩进配置行/空行，直到下一个
// `Host ` 行或 EOF），以及紧邻在其前、由本向导写入的 managed 注释行（避免重复调用后残留堆积）。
// 其他 Host 段（包括用户手写的）原样保留、顺序不变。
function stripSshHostSection(content, hostAlias) {
  const lines = (content || "").split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    const hostMatch = line.match(/^\s*Host\s+(\S+)/i);
    if (hostMatch && hostMatch[1] === hostAlias) {
      skip = true;
      if (out.length > 0 && out[out.length - 1] === MANAGED_HOST_COMMENT) out.pop();
      continue;
    }
    // 只吞掉目标 Host 段的缩进续行；任何顶格行（另一个 Host、Match 块、全局指令、
    // 注释、空行）都立即结束跳过并保留 —— 否则会误删用户写在目标段之后的 Match 块 /
    // 全局配置 / 注释，而调用方随后会用剥离结果原子覆盖整个 ~/.ssh/config（静默丢配置）。
    if (skip && /^\s+\S/.test(line)) continue;
    skip = false;
    out.push(line);
  }
  return out.join("\n");
}

function renderSshHostSection({ hostAlias, hostName, port, user, identityFile }) {
  const lines = [
    MANAGED_HOST_COMMENT,
    `Host ${hostAlias}`,
    `  HostName ${hostName}`,
    `  User ${user}`,
    `  Port ${port}`,
    `  StrictHostKeyChecking yes`,
  ];
  if (identityFile) lines.push(`  IdentityFile ${identityFile}`);
  return lines.join("\n");
}

// 纯函数（E1 修复核心）：把 existingContent 中同名旧 Host 段剥离后，在末尾追加新段，返回*完整*
// 新内容交调用方原子写回。幂等：用同样的 opts 对同一个 existingContent 重复调用两次，输出相同。
export function upsertSshConfigBlock(existingContent, { hostAlias, hostName, port, user, identityFile } = {}) {
  const stripped = stripSshHostSection(existingContent, hostAlias);
  const trimmedBase = stripped.replace(/\s+$/, "");
  const section = renderSshHostSection({ hostAlias, hostName, port, user, identityFile });
  const sep = trimmedBase.length > 0 ? "\n\n" : "";
  return `${trimmedBase}${sep}${section}\n`;
}

// 读出名为 hostAlias 的 Host 段（只认"Host 行里单独写这一个别名"的段，与 strip 同一口径）。
// 没有 → null；有 → { text, managed, hostName, user, port, identityFile }：
//   text    该段原文（Host 行 + 缩进续行，不含 managed 注释），给界面原样展示；
//   managed 紧邻其前是否有本工具的 managed 注释——是我们写的段可以直接覆盖，用户手写的要先问。
export function findSshHostSection(content, hostAlias) {
  const lines = (content || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const hostMatch = lines[i].match(/^\s*Host\s+(\S+)/i);
    if (!hostMatch || hostMatch[1] !== hostAlias) continue;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j += 1) body.push(lines[j]);
    const field = (name) => {
      const re = new RegExp(`^\\s+${name}\\s+(.+?)\\s*$`, "i");
      for (const line of body) {
        const m = line.match(re);
        if (m) return m[1].replace(/^"(.*)"$/, "$1");
      }
      return "";
    };
    const port = Number(field("Port"));
    return {
      text: body.join("\n"),
      managed: i > 0 && lines[i - 1] === MANAGED_HOST_COMMENT,
      hostName: field("HostName"),
      user: field("User"),
      port: Number.isInteger(port) && port > 0 ? port : null,
      identityFile: field("IdentityFile"),
    };
  }
  return null;
}
