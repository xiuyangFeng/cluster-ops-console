// App 内接入引导（lib/onboarding-guide/service.mjs）：
//
//   GET  /api/onboarding          → 引导状态 { available, phase, busy, dismissed, server, form, steps, prompt, result, … }
//   POST /api/onboarding/start    { sshUser, hostName?, password?, mode?: "monitor"|"full" } → 状态。新开一轮；旧客户端默认 full。
//   POST /api/onboarding/answer   { kind, … } → 状态。回答当前 prompt（指纹 / 密码 / 是否覆盖 Host 段 / 出网 / 旧代理导出）。
//   POST /api/onboarding/retry    { step? } → 状态。失败或暂停时从断点继续；已走完时可单独重跑一步。
//   POST /api/onboarding/install-openssh {} → 状态。Windows：后台装系统自带的 OpenSSH 客户端（弹 UAC），装好后从「没有 ssh」那步继续。
//   POST /api/onboarding/dismiss  { dismissed } → 状态。「稍后再说」：不再自动弹出，入口仍在。
//   POST /api/onboarding/reset    {} → 状态。清掉进度（不撤销已写下的东西）。
//
// 写接口沿用全局鉴权。密码只出现在 start / answer 的请求正文里：不记日志、不回显、不落盘。
// 表单类错误 400 { error, code, field? }，正在执行上一步时 409 { code: "busy" }；服务缺席（未装配）时 503。
// 接入管理（./onboarding-access.mjs）正在撤销接入 / 释放端口时，start / answer / retry 同样 409 { code: "busy" }：
// 两边会同时改集群上的 env.sh 与端口登记。
import { statusError } from "../../status-error.mjs";
import { isJsonObject, readJsonBody, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createOnboardingRoutes({ onboardingGuide, accessManager = null }) {
  const unavailable = (res) => sendJson(res, { error: "onboarding guide unavailable" }, 503);

  // 读正文 → 调服务 → 回状态；服务抛的 statusError 原样带上 code / field。
  const action = (run) => async ({ req, res }) => {
    if (!onboardingGuide) return unavailable(res);
    const data = await readJsonBody(req);
    if (!isJsonObject(data)) return sendJson(res, { error: "请求正文必须是 JSON 对象" }, 400);
    try {
      sendJson(res, await run(data));
    } catch (error) {
      sendJson(res, { error: error.message || "操作失败", code: error.code, field: error.field }, error.status || 500);
    }
  };

  // 会让引导往下执行步骤的动作：接入管理有动作在做时不接。
  const stepping = (run) => action((data) => {
    const notice = accessManager?.busyNotice?.();
    if (notice) throw statusError(`${notice}，等它结束再继续接入引导`, 409, { code: "busy" });
    return run(data);
  });

  return routeTable({
    "GET /api/onboarding": async ({ res }) => {
      if (!onboardingGuide) return unavailable(res);
      sendJson(res, onboardingGuide.getState());
    },
    "POST /api/onboarding/start": stepping((data) => onboardingGuide.start(data)),
    "POST /api/onboarding/answer": stepping((data) => onboardingGuide.answer(data)),
    "POST /api/onboarding/retry": stepping((data) => onboardingGuide.retry({ step: data.step ?? null })),
    "POST /api/onboarding/install-openssh": stepping(() => onboardingGuide.installOpenSsh()),
    "POST /api/onboarding/dismiss": action((data) => onboardingGuide.setDismissed(data.dismissed !== false)),
    "POST /api/onboarding/reset": action(() => onboardingGuide.reset()),
  });
}
