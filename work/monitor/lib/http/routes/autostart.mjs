// 登录电脑后自动启动（v2.62，lib/autostart/service.mjs）：配置浮层「启动」一节的读写。
//
//   GET  /api/autostart               → { supported, method, enabled, state, file, target, fromAutostart,
//                                         caveats, reason, manualCommand, detail }
//        method         launch-agent（macOS 源码安装）/ startup-folder（Windows）/ login-item（打包的 .app）/ none
//        enabled        true / false；login-item 时为 null——登录项在桌面壳里，页面经 electronAPI 读写
//        state          on / off / other-install（同一个自启文件指向别的安装目录，target 是它启动的那个）/
//                       foreign（同名文件不是工作台放的）/ unknown（读不出，detail 是原因）
//        fromAutostart  这一份监控服务是不是开机自启拉起来的
//        caveats        protected-folder：安装目录在「文稿 / 桌面 / 下载」或外接磁盘上；
//                       launcher-path-unknown：桌面壳里拿不到启动时的 PATH（入口还是更新前的旧代码），此时打开开关 409
//        reason         supported 为 false 时的原因：platform（附 manualCommand）/ unsafe-path / no-startup-folder
//   POST /api/autostart { enabled }   → 同上的载荷，外加 { changed, launchd }。
//        launchd（只在 macOS 源码安装关闭时有值）booted-out / not-loaded（launchd 里本来就没有这个任务）/
//        failed（bootout 没成，文件照样删了）/ left-running（这一份就是自启拉起来的，没有执行 bootout）/ skipped
//        不支持 / 不是工作台放的文件 / 读不出 / 打包的 App / 拿不到启动时的 PATH → 409 { error, code }；
//        写不进去、删不掉 → 500 { error, code: "io-failed" }；正文不是 { enabled: 布尔 } → 400。
//
// 写接口沿用全局鉴权（写方法必须带有效 token）。服务缺席时 503。
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendAutostartError = (res, err) => sendJson(res, { error: err.message || "autostart failed", code: err.code || undefined }, err.status || 500);

export function createAutostartRoutes({ autostart = null, appendLog = () => {} }) {
  const unavailable = (res) => sendJson(res, { error: "autostart unavailable" }, 503);

  return routeTable({
    "GET /api/autostart": async ({ res }) => {
      if (!autostart) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await autostart.status()), sendAutostartError);
    },
    "POST /api/autostart": async ({ req, res, operationContext }) => {
      if (!autostart) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || typeof data.enabled !== "boolean") {
        return sendJson(res, { error: "enabled must be a boolean" }, 400);
      }
      await respondOrError(res, async () => {
        const result = await autostart.setEnabled(data.enabled);
        if (result.changed) {
          appendLog(`autostart ${data.enabled ? "enabled" : "disabled"} (${result.method}${result.launchd ? `, launchd: ${result.launchd}` : ""})`, { ...operationContext, event: "autostart" });
        }
        sendJson(res, result);
      }, (r, err) => {
        appendLog(`autostart not changed: ${err.code || err.status || "error"}`, { ...operationContext, event: "autostart", level: "warn" });
        sendAutostartError(r, err);
      });
    },
  });
}
