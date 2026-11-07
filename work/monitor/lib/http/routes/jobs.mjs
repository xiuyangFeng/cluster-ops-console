// 「我的历史」读接口：GET /api/jobs?serverId=<id>。只读，鉴权与其它 /api/* 读接口相同。
//
// 数据是 jobs:<serverId> 探针（sacct，5 分钟一轮，覆盖近 48 小时）留在内存里的快照；这里不发 SSH，
// 只把快照聚合成可展示的行（lib/jobs/model.mjs buildJobsHistory：有问题的在前、同名实验折成组）。
// 想要更新鲜的数据用 POST /api/probe/jobs:<serverId>/run 触发一轮采集后再读。
//
// 没有快照（从未采集 / 这台服务器不在作业采集范围）不是错误：返回 state "none"，前端显示空态。
// 设置页「监控模块」关掉「我的作业」时回 200 { disabled: true }（前端显示「模块已关闭」）。
//
// v2.49 失败作业诊断（同样只读本机存储、不发 SSH）：
//   GET /api/jobs 的作业行（顶层单条行与折叠组 children）多一个 diagnosis: { category, headline } | null；
//   GET /api/jobs/diagnoses?serverId=<id>[&since=<epoch 毫秒>] → { items, groups }
//     items：[{ jobId, serverId, name, state, exitCode, endedAtMs, category, headline, evidence[], files[{ path, tail }], hasScript, source }]
//     groups：[{ key, category, headline, count, jobIds }]（同因归组，多的在前）
//   GET /api/jobs/diagnoses/script?serverId=<id>&jobId=<作业号> → { jobId, script: string | null }
//
// v2.51 日志按段向前读取（唯一会发 SSH 的读接口：每个未缓存的片段一次，经调度器全局槽位；见 lib/jobs/log-readback.mjs）：
//   GET /api/jobs/log-segment?serverId=&jobId=&from=watch|diagnosis&log=stdout|stderr|0-5
//       [&before=&ino=&size=&mtimeMs=&sig=]（上一段回传的 next 游标）[&fresh=1]（从当前末尾重新读）
//     → { jobId, from, log, role, path, start, end, size, dropped, noBreak, text, atStart, next, anchorText, anchorCheckedAt, continuous, notes, cached, fetchedAt }
//     文件已轮转 / 截断 / 改写 / 删除 → 409 { error, code }；参数不合格 → 400；同时在读的片段过多 → 429。
//
// 关注与提醒（只动本机 job-watch.json，不发 SSH；业务在 lib/jobs/watch-service.mjs）：
//   GET /api/jobs/watch                → 全局收件箱 { settings: { quietUntil }, notifications,
//                                         servers: [{ serverId, name, rules, suggestions }] }（v2.62：每台在采集范围内的服务器的提醒规则）
//   GET /api/jobs/watch?serverId=<id>  → 这台服务器的 { settings, watches, resources, notifications, rules, suggestions }
//     notifications[]：{ id, serverId, watchId, kind, createdAt, title, body, jobIds, readAt, intro? }；
//       v2.62 起 kind "failed"（作业失败提醒）不属于任何关注组，watchId 为 null；intro 只出现在默认规则下的头一条失败提醒上。
//     watches[]：自动关注的组多一个 auto: { rule }（"name:<通配>" 或 "longRun"）；只收在跑的与刚结束的作业，排队中的不进组。
//     rules：{ failNotify, longRunMinutes, patterns }；
//     suggestions：[{ prefix, pattern, count }]（近 7 天作业名的前缀，至多 8 个；count = 这条规则加上后会命中的作业数）。
//   POST /api/jobs/watch[?serverId=]   body.action = watch | unwatch | mute | settings | ack | rules，回与 GET 同形的视图。
//     rules（v2.62，需要 serverId）：只带要改的字段——
//       { failNotify?: boolean, longRunMinutes?: 10–10080 的整数 | null,
//         patterns?: string[]（整份替换）| addPattern?: string / removePattern?: string（只加 / 只删一条；界面用这两个，
//         手里的列表过时也不会盖掉别处的改动；加已有的、删没有的都算成功） }；
//       名字规则最多 12 条、每条 ≤ 64 字符、只认 * 与 ?；不合格 → 400，整次不生效。
//     对自动组 unwatch = 停用产生它的那条规则；mute 记在规则上（组被挤掉再建回来仍然静音）。
//     静音的组（手动或自动）里的作业失败时不发失败提醒。
import { buildJobsHistory } from "../../jobs/model.mjs";
import { isDataModuleEnabled } from "../../modules/catalog.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { readJsonBody, respondOrError, sendJson } from "../io.mjs";
import { parseSegmentQuery } from "../../jobs/log-readback.mjs";
import { routeTable } from "../route-kit.mjs";

const JOB_ID_RE = /^\d{1,12}(?:_\d{1,9})?$/;

export function createJobsRoutes({ jobsService, getConfig = async () => null, acquireSshSlot = null }) {
  // 三个接口共用的前置：模块开关 → 服务在不在 → serverId 白名单。返回 serverId 或 null（已写出响应）。
  async function precheck(res, url, optionalServer = false) {
    if (!isDataModuleEnabled(await getConfig(), "jobs")) {
      sendJson(res, { disabled: true });
      return null;
    }
    if (!jobsService) {
      sendJson(res, { error: "jobs unavailable" }, 503);
      return null;
    }
    const serverId = url.searchParams.get("serverId") || "";
    if (optionalServer && !url.searchParams.has("serverId")) return "";
    // 白名单格式校验在任何查找之前：非法一律 400。
    if (!isBoundedServerId(serverId)) {
      sendJson(res, { error: "invalid serverId" }, 400);
      return null;
    }
    return serverId;
  }

  return routeTable({
    "GET /api/jobs/watch": async ({ res, url }) => {
      const serverId = await precheck(res, url, true);
      if (serverId === null) return;
      if (!jobsService.getWatchView) return sendJson(res, { error: "job watch unavailable" }, 503);
      await respondOrError(res, async () => sendJson(res, await jobsService.getWatchView(serverId || null)));
    },
    "POST /api/jobs/watch": async ({ req, res, url }) => {
      const serverId = await precheck(res, url, true);
      if (serverId === null) return;
      if (!jobsService.changeWatch) return sendJson(res, { error: "job watch unavailable" }, 503);
      const body = await readJsonBody(req, 16384);
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, { error: "invalid request body" }, 400);
      await respondOrError(res, async () => sendJson(res, await jobsService.changeWatch(serverId || null, body)));
    },
    "GET /api/jobs": async ({ res, url }) => {
      const serverId = await precheck(res, url);
      if (serverId === null) return;
      await jobsService.ready?.();
      const diagnosisOf = jobsService.diagnosisOf ? (jobId) => jobsService.diagnosisOf(serverId, jobId) : null;
      const sessionOf = jobsService.sessionOf ? (jobId, row) => jobsService.sessionOf(serverId, jobId, row) : null;
      sendJson(res, buildJobsHistory(jobsService.getSnapshot(serverId), { serverId, diagnosisOf, sessionOf }));
    },
    "GET /api/jobs/diagnoses": async ({ res, url }) => {
      const serverId = await precheck(res, url);
      if (serverId === null) return;
      const sinceRaw = url.searchParams.get("since");
      if (sinceRaw !== null && !/^\d{1,15}$/.test(sinceRaw)) return sendJson(res, { error: "invalid since" }, 400);
      if (!jobsService.listDiagnoses) return sendJson(res, { items: [], groups: [] });
      sendJson(res, await jobsService.listDiagnoses(serverId, { since: sinceRaw === null ? null : Number(sinceRaw) }));
    },
    "GET /api/jobs/log-segment": async ({ res, url }) => {
      const serverId = await precheck(res, url);
      if (serverId === null) return;
      if (!jobsService.readLogSegment) return sendJson(res, { error: "log readback unavailable" }, 503);
      let query;
      try {
        query = parseSegmentQuery(url.searchParams);
      } catch (error) {
        return sendJson(res, { error: error.message }, 400);
      }
      await respondOrError(
        res,
        async () => sendJson(res, await jobsService.readLogSegment(serverId, query, { acquireSshSlot })),
        (r, error) => sendJson(r, { error: error.message, ...(typeof error.code === "string" ? { code: error.code } : {}) }, error.status || 500),
      );
    },
    "GET /api/jobs/diagnoses/script": async ({ res, url }) => {
      const serverId = await precheck(res, url);
      if (serverId === null) return;
      const jobId = url.searchParams.get("jobId") || "";
      if (!JOB_ID_RE.test(jobId)) return sendJson(res, { error: "invalid jobId" }, 400);
      const script = jobsService.getDiagnosisScript ? await jobsService.getDiagnosisScript(serverId, jobId) : null;
      sendJson(res, { jobId, script: typeof script === "string" ? script : null });
    },
  });
}
