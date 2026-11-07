// app/cli-controller.js —— Agent 卡片上的官方 CLI 版本 / 登录方式 / 「可更新到 x」：低频拉取 GET /api/cli。
//
// 后端 cli:<serverId> 探针 10 分钟一轮、最新版本 6 小时一取，这里 5 分钟拉一次足够；切换查看的服务器时
// 立即补拉一次（结果按 serverId 对齐，旧服务器的结果不会显示到新服务器的卡片上）。
// 安静降级：接口不存在（404，安装/版本模块未就绪的版本）→ 本次页面不再请求；其它失败保留上一份、下一轮再试。
// 页面隐藏时不拉，恢复可见时补一次。拿到的结果经 onCli 交给 render/overview.js 的 setAgentCliPayload。

export const CLI_POLL_MS = 5 * 60000;

export function createCliController({ getJson, isHidden = () => false, onVisibilityChange, onCli, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let payload = null;
  let unsupported = false;
  let inFlight = null;
  let timer = null;
  let lastServerId = null;

  async function refresh() {
    if (unsupported) return payload;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await getJson("/api/cli");
        payload = next && typeof next === "object" ? next : null;
        onCli?.(payload);
      } catch (err) {
        if (err?.status === 404) {
          unsupported = true;
          payload = null;
          onCli?.(null);
        }
        // 其它失败（超时 / 401 / 500）：保留上一份，下一轮再试。
      } finally {
        inFlight = null;
      }
      return payload;
    })();
    return inFlight;
  }

  function schedule() {
    clearTimer(timer);
    timer = null;
    if (unsupported || isHidden()) return;
    timer = setTimer(async () => {
      if (!isHidden()) await refresh();
      schedule();
    }, CLI_POLL_MS);
  }

  function start() {
    refresh();
    schedule();
    onVisibilityChange?.(() => {
      if (!isHidden()) refresh();
      schedule();
    });
  }

  // 每次状态渲染时调用：查看的服务器变了就补拉一次（首帧只记录，start() 已经拉过）。
  function onStatus(status) {
    const serverId = status?.activeServerId ?? null;
    if (lastServerId !== null && serverId !== lastServerId) refresh();
    lastServerId = serverId;
  }

  function stop() {
    clearTimer(timer);
    timer = null;
  }

  return { start, stop, refresh, onStatus, getPayload: () => payload, isUnsupported: () => unsupported };
}
