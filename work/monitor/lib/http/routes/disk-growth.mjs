// 磁盘增长归因（v2.62，lib/disk-growth/）：
//   GET  /api/disk-growth?serverId=<id>
//        读本机已存的测量（不发 SSH）：{ eligible, serverId, running, run, growth, trend, detail }
//        growth：最近一次测量的各集合目录、按增长排序的前 8 个子目录与合计（从没量过 → null）；
//        trend / detail：简报同一份磁盘趋势，以及磁盘事件详情里的那句话（lib/disk-growth/detail.mjs）。
//        不是团队服务器 → { eligible: false }；「我的 Slurm 作业」模块关着 → { eligible: true, disabled: true }。
//   POST /api/disk-growth/scan  { serverId }
//        按需量一次：校验后立刻返回（同 GET 的形状），测量在后台进行，进度看 GET。
//        同一台同一时刻只跑一个、用户正在扫目录占用、模块关着 → 409；不是团队服务器 → 404。
//        fixture 模式（冒烟 / 界面预览）下服务整个停用，这里一律 409「fixture 模式不发起真实 SSH」。
// 鉴权与其它 /api/* 相同（POST 必须带 token）。测量的 SSH 占调度器全局槽位（并发上限 3）。
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendError = (res, error) => sendJson(res, { error: String(error?.message || error) }, error?.status || 500);

export function createDiskGrowthRoutes({ diskGrowthService, describeDisk = null, scheduler = null }) {
  const acquireSshSlot = scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null;

  // 量得出东西的服务器才带趋势与那句话；不在范围 / 模块关着的原样返回。
  async function withDetail(view) {
    if (!describeDisk || view.eligible !== true || view.disabled === true) return view;
    const { text, trend } = await describeDisk(view.serverId);
    return { ...view, trend, detail: text };
  }

  return routeTable({
    "GET /api/disk-growth": async ({ res, url }) => {
      if (!diskGrowthService) return sendJson(res, { error: "disk-growth unavailable" }, 503);
      const serverId = url.searchParams.get("serverId");
      if (!isBoundedServerId(serverId)) return sendJson(res, { error: "服务器无效" }, 400);
      await respondOrError(res, async () => sendJson(res, await withDetail(await diskGrowthService.get(serverId))), sendError);
    },
    "POST /api/disk-growth/scan": async ({ req, res }) => {
      if (!diskGrowthService) return sendJson(res, { error: "disk-growth unavailable" }, 503);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || !isBoundedServerId(data.serverId)) return sendJson(res, { error: "服务器无效" }, 400);
      await respondOrError(res, async () => sendJson(res, await withDetail(await diskGrowthService.scanNow(data.serverId, acquireSshSlot ? { acquireSshSlot } : {}))), sendError);
    },
  });
}
