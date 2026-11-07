// 本机资源：/api/local/resources（完整样本）与 /api/local/processes（只要进程表）。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 15s 内的样本直接复用：两个接口常被前端同时拉取，没必要各自 ps 一次。
const SAMPLE_FRESH_MS = 15000;
const PROCESS_LIMIT_DEFAULT = 20;
const PROCESS_LIMIT_MAX = 50;

// limit 取整后夹在 [1,50]；缺失 / 非数字 / 0 → 20。
function processLimit(url) {
  return Math.min(PROCESS_LIMIT_MAX, Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || PROCESS_LIMIT_DEFAULT));
}

export function createLocalResourceRoutes({ localResourceProbe }) {
  // 新鲜缓存或重新采样；采样器关闭中返回空，调用方回 503。
  async function currentSample() {
    const last = localResourceProbe.getLast();
    return last && Date.now() - Date.parse(last.observedAt) < SAMPLE_FRESH_MS ? last : await localResourceProbe.sample();
  }

  return routeTable({
    "GET /api/local/resources": async ({ res, url }) => {
      const sample = await currentSample();
      if (!sample) return sendJson(res, { error: "本机采样器正在关闭" }, 503);
      sendJson(res, { ...sample, topProcesses: (sample.topProcesses || []).slice(0, processLimit(url)) });
    },
    "GET /api/local/processes": async ({ res, url }) => {
      const sample = await currentSample();
      if (!sample) return sendJson(res, { error: "本机采样器正在关闭" }, 503);
      sendJson(res, {
        schemaVersion: 1,
        scope: "local",
        observedAt: sample.observedAt,
        quality: sample.quality,
        processes: (sample.topProcesses || []).slice(0, processLimit(url)),
      });
    },
  });
}
