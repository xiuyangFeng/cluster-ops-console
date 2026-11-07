// 自更新（v2.59，lib/self-update/service.mjs）：源码安装从 GitHub 取新版本，界面提示后一键更新。
// 跟远端的哪个分支由更新通道定（v2.62，lib/self-update/channel.mjs）：安装目录在 stable 上跟 origin/stable，在 main 上跟 origin/main。
//
//   GET  /api/self-update          → 现状（不联网）：{ supported, kind, unsupportedReason, branch, channel, stableAvailable,
//                                     remote, localVersion, remoteVersion, behind, available, canApply, blockers,
//                                     checkedAt, error, checking, applying, respawn, lastUpdate }
//                                     kind：git / packaged / plain（不是仓库）/ no-git / unsafe-owner（git 因目录归属
//                                     拒绝读它，unsupportedReason 里带放行命令）；后四种 supported 为 false。
//                                     这一次没读出安装目录的状态不算「不支持」：supported 沿用上次的值（没有就是
//                                     null），原因在 error（code: inspect-failed）。
//                                     channel："stable" / "main"；不在任何通道的分支上为 null（那时不自动更新）。
//                                     stableAvailable：远端有稳定版分支。稳定版的安装遇到远端没有 stable 分支时
//                                     error.code 为 no-channel-branch。接口只读通道、不换通道——换通道只有命令行
//                                     npm run update -- --channel stable|main 一个入口
//   POST /api/self-update/check    → 立刻 git fetch 一次，同上的载荷（fetch 失败也是 200，原因在 error 里）
//   POST /api/self-update/apply    → 自检目标版本 → 快进合并。{ ok, fromVersion, toVersion, respawn }；
//                                     不满足条件 409 / 自检没过 422 / 取不到远端 502，都带 { error, code }。
//                                     回退后被跳过的那一版在这里一律 409（code: skipped）；装回去只有命令行
//                                     npm run update -- --force 一个出口，接口不收这个开关
//   POST /api/self-update/restart  → 网页模式：监控服务以约定的退出码结束，由 launch.mjs 重新拉起（隧道不断）。
//                                     不是 launch.mjs 起的（桌面壳 / 手工起的）→ 409，桌面壳用它自己的「重启界面」
//
// 写接口沿用全局鉴权（写方法必须带有效 token）。服务缺席（fixture 模式等）时 503。
import { respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendUpdateError = (res, err) => sendJson(res, { error: err.message || "self-update failed", code: err.code || undefined }, err.status || 500);

export function createSelfUpdateRoutes({ selfUpdate = null, requestRestart = null, appendLog = () => {} }) {
  const unavailable = (res) => sendJson(res, { error: "self-update unavailable" }, 503);

  return routeTable({
    "GET /api/self-update": async ({ res }) => {
      if (!selfUpdate) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await selfUpdate.status()), sendUpdateError);
    },
    "POST /api/self-update/check": async ({ res }) => {
      if (!selfUpdate) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await selfUpdate.check({ force: true })), sendUpdateError);
    },
    "POST /api/self-update/apply": async ({ res, operationContext }) => {
      if (!selfUpdate) return unavailable(res);
      await respondOrError(res, async () => {
        const result = await selfUpdate.apply();
        appendLog(`self-update applied: v${result.fromVersion} -> v${result.toVersion}`, { ...operationContext, event: "self-update" });
        sendJson(res, result);
      }, (r, err) => {
        appendLog(`self-update not applied: ${err.code || err.status || "error"}`, { ...operationContext, event: "self-update", level: "warn" });
        sendUpdateError(r, err);
      });
    },
    "POST /api/self-update/restart": async ({ res, operationContext }) => {
      if (!selfUpdate) return unavailable(res);
      if (!selfUpdate.respawn || typeof requestRestart !== "function") {
        return sendJson(res, { error: "当前的启动方式不会自动把监控服务重新拉起来：请手动重启工作台（桌面窗口里用「重启界面」）", code: "no-respawn" }, 409);
      }
      appendLog("self-update: restarting monitor server (data plane preserved)", { ...operationContext, event: "self-update" });
      sendJson(res, { ok: true });
      // 先让这次响应发出去，再开始优雅退出。
      setTimeout(() => requestRestart(), 150);
    },
  });
}
