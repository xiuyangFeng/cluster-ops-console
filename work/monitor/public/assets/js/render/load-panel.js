// load-panel.js —— 服务器页「资源与负载」面板的 DOM 接线层。
// 模型在 resources-model.js（纯函数），HTML 片段在 resources-view.js（纯字符串）；
// 这里只负责：取 DOM、推进环比状态、就地修补、把统一口径的采样点交给 charts.js，
// 再把 charts.js 那边的趋势摘要（范围内高低值、近 7 天磁盘序列）挂回明细行。
import { claimTrendServer, getTrendSummary, onTrendChange, pushSample, trendRevision } from "../charts.js";
import { gpuTrendRevision, onGpuTrendChange } from "../gpu-trend.js";
import { createElementLookup, morphInnerHtml, setAttr, setText } from "../dom-utils.js";
import { clampPct } from "../thresholds.js";
import { createMemoRender, timeBucket } from "./render-skip.js";
import { buildResourcePanelModel, directGpuNodes, withSampleDeltas, withTrendNotes } from "./resources-model.js";
import { buildResourceNoticeHtml, buildTileBodyHtml } from "./resources-view.js";
import { buildTunnelEgressModel } from "./tunnel-egress-model.js";
import { buildTunnelEgressHtml } from "./tunnel-egress-view.js";

// DOM 引用惰性获取（无 document 时返回 null，纯函数可在 Node 测试中导入）。
const getEl = createElementLookup();

// 进度用 transform: scaleX 表达（条本体恒 width:100%、transform-origin 在左）：
// 过渡只走合成层，不再像 width 过渡那样动画期间逐帧重排。
export function progressScale(percentage) {
  return `scaleX(${clampPct(percentage) / 100})`;
}

export function updateProgressBar(barElement, percentage, colorClass) {
  if (!barElement) return;
  barElement.style.width = "100%";
  barElement.style.transform = progressScale(percentage);
  barElement.className = `bar-progress ${colorClass}-bar color-${colorClass}`;
}

// 环比状态机：按「服务器 + 采样时刻」推进。同一采样的重复渲染（时间桶刷新相对时间、
// SSE 高频到达）不推进，否则上一采样会被当前值覆盖、箭头永远显示持平。
// 切换服务器清零（跨机对比无意义）。返回当前采样对应的"上一采样"。
export function createSampleTrack() {
  let serverKey = null;
  let sampleKey = null;
  let current = null;
  let previous = null;
  return {
    advance(nextServerKey, nextSampleKey, sample) {
      if (nextServerKey !== serverKey) {
        serverKey = nextServerKey;
        sampleKey = null;
        current = null;
        previous = null;
      }
      if (nextSampleKey == null || String(nextSampleKey) !== String(sampleKey)) {
        previous = current;
        current = sample;
        sampleKey = nextSampleKey == null ? null : String(nextSampleKey);
      }
      return previous;
    },
  };
}

const sampleTrack = createSampleTrack();

// app.js 当前只传 usage 与 sampleKey（= 层的 checkedAt）；没拿到整层时拼一个最小层，
// 让模型照样算新鲜度（GPU / 层级别此时缺席，面板相应隐藏或按旧通路判定）。
function resolveLayer(layer, usage, sampleKey) {
  if (layer && typeof layer === "object") return layer;
  const n = Number(sampleKey);
  const checkedAt = sampleKey != null && Number.isFinite(n) && n > 1e12 ? n : null;
  if (!usage && checkedAt == null) return null;
  return { usage: usage || null, checkedAt };
}

const TILE_IDS = { cpu: "resCpu", memory: "resMemory", disk: "resDisk" };

// 上一轮渲染的入参：趋势数据晚到（切范围 / 历史到货）时拿它补渲一次。
let lastArgs = null;

function renderRemoteLoadImpl(load, activeServer, sampleKey = null, usage = null, layer = null, now = Date.now()) {
  lastArgs = [load, activeServer, sampleKey, usage, layer];
  // 趋势图的实时序列要属于正在看的这台（不是就当场认领并重新播种），再取摘要、推采样点。
  claimTrendServer(activeServer?.id);
  const host = activeServer?.host || "-";
  const base = buildResourcePanelModel({ layer: resolveLayer(layer, usage, sampleKey), remoteLoad: load, host, now });
  const serverKey = activeServer?.id || host;
  const dataKey = base.dataAt ?? sampleKey;
  const model = withTrendNotes(
    withSampleDeltas(base, base.hasData ? sampleTrack.advance(serverKey, dataKey, base.sample) : null),
    getTrendSummary(now),
  );

  setText(getEl("hostBadge"), model.host);
  const fresh = getEl("resFreshness");
  setText(fresh, model.freshness.text);
  setAttr(fresh, "data-level", model.freshness.level);
  setAttr(fresh, "title", model.freshness.title);

  // 从没采到过数据：指标块上方一条等待 / 取不到的说明（有数据后收起，旧数据由胶囊说明新鲜度）。
  const notice = getEl("resNotice");
  if (notice) {
    const noticeHtml = buildResourceNoticeHtml(model.firstSample);
    if (notice.hidden === Boolean(noticeHtml)) notice.hidden = !noticeHtml;
    if (noticeHtml) morphInnerHtml(notice, noticeHtml);
  }

  for (const [key, prefix] of Object.entries(TILE_IDS)) {
    const tile = model.tiles[key];
    setAttr(getEl(`${prefix}Tile`), "data-level", tile.level);
    morphInnerHtml(getEl(`${prefix}Body`), buildTileBodyHtml(tile));
  }

  // 经隧道出网的程序（layers.resources[id].tunnelEgress）：旧采集脚本 / 还没采到 / 不建隧道的服务器整块隐藏。
  const egressSection = getEl("resEgressSection");
  if (egressSection) {
    const egress = buildTunnelEgressModel(layer?.tunnelEgress, activeServer);
    if (egressSection.hidden === egress.visible) egressSection.hidden = !egress.visible;
    if (egress.visible) morphInnerHtml(egressSection, buildTunnelEgressHtml(egress));
  }

  // 采集失败时展示的是上次残留数据：不再往曲线里补一个"新"点。
  // 三条曲线与 tile 大字同一口径（sample 由模型按 pickCpuMetric 统一给出）。
  if (model.hasData && model.freshness.level !== "error") {
    pushSample({ cpu: model.sample.cpu, ram: model.sample.ram, disk: model.sample.disk }, { dedupeKey: dataKey });
  }
}

// 签名必须包含 sampleKey：探针 checkedAt 变化即新采样点，charts 依赖每次真实采样
// 都走到 pushSample（其内部按 dedupeKey 去重）。其余分量：usage / GPU / 占用现场 / 经隧道出网的程序全量（均为数百字节
// 的小对象）、层级别与原因、相对时间桶（「采样于 N 秒前」数据不变也要走字），以及趋势版本号
// （切范围 / 历史到货后，明细行里的高低值与磁盘走势要跟着变）。
// 不 stringify 数 KB 的 sys 原文：它的变化必然伴随新一轮探针 → sampleKey 变化。
export const renderRemoteLoad = createMemoRender(
  renderRemoteLoadImpl,
  (load, activeServer, sampleKey = null, usage = null, layer = null, now = Date.now()) =>
    [
      load ? (load.ok ? "ok" : "fail") : "none",
      load?.output ? 1 : 0,
      (activeServer && (activeServer.id || activeServer.host || activeServer.name)) || "",
      activeServer?.host || "",
      sampleKey ?? "",
      JSON.stringify(layer?.usage ?? usage ?? null),
      layer ? `${layer.level ?? ""}/${layer.reason ?? ""}/${layer.checkedAt ?? ""}/${layer.backoff?.nextProbeAt ?? ""}` : "",
      JSON.stringify(layer?.gpu ?? null),
      JSON.stringify(directGpuNodes(layer?.slurm)),
      JSON.stringify(layer?.procTop ?? null),
      JSON.stringify(layer?.tunnelEgress ?? null),
      activeServer?.tunnel === false ? "no-tunnel" : "",
      timeBucket(now),
      trendRevision(),
      gpuTrendRevision(),
    ].join("|"),
);

// 趋势数据变了：用上一轮的入参补渲一次（签名里的趋势版本号保证不被跳过）。
onTrendChange(() => {
  if (lastArgs) renderRemoteLoad(...lastArgs);
});
onGpuTrendChange(() => {
  if (lastArgs) renderRemoteLoad(...lastArgs);
});
