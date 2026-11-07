// codex-app-server.js —— Codex 详情里「重启守护进程…」的接线层（v2.85）。
//
// 背景：桌面端 / IDE 远程模式的消息由集群上一个常驻 `codex app-server` 处理，它在启动时把
// HTTPS_PROXY 定住了。换过隧道端口之后，它仍走旧端口 → 桌面端发消息没有回复。后端 doctor 探针
// 顺带读回它的代理端口，漂移时详情里出现这一行；点按钮经 POST /api/codex/app-server/restart
// 让远端用登录 shell 重启它（会中断当前远程会话，桌面端随后自动重连）。
//
// 事件用 document 级委托：详情区每次状态刷新都会就地重画，按钮本身会被替换。
import { showToast } from "../toast.js";

export const RESTART_CONFIRM_TEXT = "重启集群上的 Codex 客户端守护进程？正在进行的远程会话会中断，桌面端会自动重连。";

// 接口返回 → toast（纯函数，测试用）。
export function restartToast(res) {
  if (res?.ok) {
    return { type: "success", title: "Codex 客户端守护进程", message: res.message || "已重启，桌面端重连后会使用当前隧道端口。" };
  }
  return {
    type: "warn",
    title: "重启没有成功",
    message: res?.message || res?.error || "远端没有返回重启结果，可稍后重试或到服务器上执行 codex app-server daemon restart。",
  };
}

export function createCodexAppServerRestart({
  doc, postJson, showToast: toast = showToast, confirm = () => true, refresh = null,
  getActiveServerId = () => null, setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
  let busy = false;

  async function onClick(event) {
    const btn = event.target?.closest?.("[data-codex-app-server-restart]");
    if (!btn || busy) return;
    if (!confirm(RESTART_CONFIRM_TEXT)) return;
    const serverId = getActiveServerId() || btn.getAttribute("data-codex-app-server-restart") || null;
    busy = true;
    btn.disabled = true;
    try {
      const res = await postJson("/api/codex/app-server/restart", serverId ? { serverId } : {});
      toast(restartToast(res));
      // 重启后的 doctor 补跑是异步的：先刷一次把任务状态带回来，再等两拍让新端口落地。
      await refresh?.({ force: true });
      setTimer(() => refresh?.({ force: true }), 3000);
      setTimer(() => refresh?.({ force: true }), 8000);
    } catch (err) {
      toast({
        type: "warn",
        title: "重启没有成功",
        message: err?.serverMessage || err?.message || "请求失败，稍后再试。",
      });
    } finally {
      busy = false;
      if (btn.isConnected) btn.disabled = false;
    }
  }

  return {
    init() {
      doc.addEventListener("click", onClick);
    },
    handleClick: onClick,
  };
}
