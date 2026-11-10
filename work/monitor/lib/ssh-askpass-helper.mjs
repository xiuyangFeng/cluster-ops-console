// 可直接作为 Node --import 的入口：在 Node 尝试把 SSH 提示词当脚本路径前完成应答。
// Windows OpenSSH 通过 CreateProcess 启动原生 node/Electron，无需 .cmd 或 PATH。
import { assertVaultPassword } from "./vault-ipc.mjs";

export async function replyToAskpass(prompt) {
  try {
    if (!/password[:?]?\s*$/i.test(prompt)) return 1;
    const url = new URL(process.env.CODEX_ASKPASS_URL);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return 1;
    const result = await fetch(`${url.origin}/password`, { method: "POST", body: JSON.stringify({ prompt }), redirect: "error", signal: AbortSignal.timeout(5000), headers: { "x-askpass-token": process.env.CODEX_ASKPASS_TOKEN || "" } });
    if (!result.ok) return 1;
    const { password } = await result.json();
    process.stdout.write(assertVaultPassword(password));
    return 0;
  } catch { return 1; }
}

if (process.env.CODEX_ASKPASS_NATIVE_ENTRY === "1") process.exit(await replyToAskpass(process.argv.slice(1).join(" ")));
