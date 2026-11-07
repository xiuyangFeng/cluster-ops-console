// 通道启停（全局动作）：POST /api/start | /api/stop | /api/restart，成功后回完整状态载荷。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createChannelRoutes({ startChannel, stopChannel, restartChannel, dataPlaneUpgrader, getStatusPayload }) {
  return routeTable({
    "POST /api/start": async ({ res, operationContext }) => {
      await startChannel(operationContext);
      sendJson(res, getStatusPayload());
    },
    "POST /api/stop": async ({ res, operationContext }) => {
      // 数据面升级在飞时不接受停止：升级会在旧 supervisor 退出后拉起新实例，与停止互相覆盖。
      // 选择如实 409 而不是排队：升级最多几十秒，前端/用户稍后再点即可。
      if (dataPlaneUpgrader.isInFlight() === true) {
        return sendJson(res, { error: "后台组件正在无缝升级（通常十几秒内完成），请稍后再停止通道" }, 409);
      }
      await stopChannel(operationContext);
      sendJson(res, getStatusPayload());
    },
    "POST /api/restart": async ({ res, operationContext }) => {
      // v2.18：手动重启也走 lifecycle 的 restartChannel（同一个 in-flight 旗标），让自动修复
      // 策略在人点"一键修复"期间静默。
      const result = await restartChannel({ trigger: "manual", context: operationContext });
      // v2.19：此前这里丢弃返回值，重入或被远端动作挡下时照样回 200 + 完整 status，
      // 前端 runbook 只能干等 120s 超时才知道压根没执行。现在如实回 409。
      if (result && result.ok === false) {
        return sendJson(res, { error: result.reason || "restart rejected" }, 409);
      }
      sendJson(res, getStatusPayload());
    },
  });
}
