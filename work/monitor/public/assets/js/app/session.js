// app/session.js —— 会话接入：桌面壳按钮 + API Token 注入。
//
// 桌面模式（Electron，有 window.electronAPI）：显示隐藏/退出按钮，Token 走 IPC 取。
// Web 模式：没有 IPC 通道，从同源 /api/session 取 Token，否则写操作（start/stop/restart）
// 在 C3 加固后会被 401。跨源页面读不到该响应。
// 取 Token 失败一律静默：后续请求的 401 会走 reportApiError 的鉴权失败提示。
import { QUIT_CONFIRM_TEXT } from "../ui-labels.js";

const fetchSessionFromServer = () => fetch("/api/session").then((r) => (r.ok ? r.json() : null));

export async function initSession({ doc, electronAPI = null, configure, confirm, fetchSession = fetchSessionFromServer }) {
  if (electronAPI) {
    const controls = doc.getElementById("desktopControls");
    if (controls) controls.style.display = "flex";
    doc.getElementById("desktopHideBtn")?.addEventListener("click", () => electronAPI.hideWindow());
    // 退出会停止所有后台连接：与「停止所有连接」同级的破坏性动作，先确认（W5）。
    doc.getElementById("desktopQuitBtn")?.addEventListener("click", () => {
      if (!confirm(QUIT_CONFIRM_TEXT)) return;
      electronAPI.quitApp();
    });
    try {
      configure({ token: await electronAPI.getAuthToken() });
    } catch {}
    return;
  }
  try {
    const session = await fetchSession();
    if (session?.token) configure({ token: session.token });
  } catch {}
}
