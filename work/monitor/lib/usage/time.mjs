// 用量统计的时区：固定北京时间（UTC+8，中国不实行夏令时，固定偏移即准确）。
// 与本机系统时区无关——控制台可能跑在任何时区的电脑上，但「今天」「几点」都按北京时间算，
// 日文件归日、趋势分档、近 7 日同时段比较、页面显示全部用这一个口径。
// 偏移量只有 lib/beijing-time.mjs 一份；这里是它的秒级（用量记录的时间戳是 epoch 秒）包装。
import { BEIJING_OFFSET_MS, offsetDay } from "../beijing-time.mjs";

export const USAGE_TZ_OFFSET_SEC = BEIJING_OFFSET_MS / 1000;
export const USAGE_TZ_LABEL = "北京时间";

const pad = (n) => String(n).padStart(2, "0");
const shifted = (epochSec) => new Date((epochSec + USAGE_TZ_OFFSET_SEC) * 1000);
const DAY_MS = 86_400_000;
const MAX_TIME_MS = 8.64e15; // Date 能表示的范围；超出时交给 Date 自己（得到 NaN 日期），与原写法一致

// 与 new Date((sec + 偏移) * 1000) 同一换算（毫秒向零取整、按 UTC 日界分天），但不为每条记录新建 Date（perf）：
// 冷启动加载用量要给十万条调用归日，摘要还要给每次调用分时段。日期键按「第几天」缓存，同一天只拼一次字符串。
const shiftedMs = (epochSec) => Math.trunc((epochSec + USAGE_TZ_OFFSET_SEC) * 1000);
const dayKeyCache = new Map(); // 北京时间第几天 → YYYY-MM-DD
const DAY_KEY_CACHE_MAX = 4096;

export function dayKeyOf(epochSec) {
  const ms = shiftedMs(epochSec);
  if (!(Math.abs(ms) <= MAX_TIME_MS)) {
    const d = shifted(epochSec);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const dayNo = Math.floor(ms / DAY_MS);
  let key = dayKeyCache.get(dayNo);
  if (key === undefined) {
    const d = new Date(dayNo * DAY_MS);
    key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (dayKeyCache.size >= DAY_KEY_CACHE_MAX) dayKeyCache.clear();
    dayKeyCache.set(dayNo, key);
  }
  return key;
}

// 北京时间当天的第几秒（0–86399）
export function secondsOfDay(epochSec) {
  const ms = shiftedMs(epochSec);
  if (!(Math.abs(ms) <= MAX_TIME_MS)) {
    const d = shifted(epochSec);
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  }
  return Math.floor((ms - Math.floor(ms / DAY_MS) * DAY_MS) / 1000);
}

// 日期键 ± N 天（纯日历运算，与时区无关）
export { offsetDay };
