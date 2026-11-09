export const PACKAGE_UPDATE_PHASES = Object.freeze({
  download: "正在下载更新包…",
  verify: "正在校验更新包…",
  smoke: "正在检查新版本能否正常启动…",
  backup: "正在备份当前版本…",
  install: "正在应用更新…",
  ready: "更新已就绪，正在重启界面…",
});

export async function waitForPackageUpdate({ getJson, onProgress = () => {}, timeoutMs = 20 * 60_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const state = (await getJson("/api/self-update"))?.packageUpdate;
    if (!state) throw new Error("没有找到更新任务，请重新检查更新");
    onProgress(PACKAGE_UPDATE_PHASES[state.phase] || "正在更新…");
    if (state.error) throw new Error(state.error);
    if (state.ready) return state;
    await sleep(750);
  }
  throw new Error("更新仍在后台进行，可稍后回到此页面查看进度");
}
