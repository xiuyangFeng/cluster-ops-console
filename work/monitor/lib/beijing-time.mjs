// 北京时间（UTC+8，中国不实行夏令时，固定偏移即准确）的日界换算——后端唯一一份偏移量。
//
// 与进程的本机时区无关：控制台可能跑在任何时区的电脑上，也可能从带着别的 TZ 环境变量的终端里
// 重启（热更新），但历史日文件、用量归日、简报、隧道稳定性的「哪一天」都按北京时间算。
// 需要日界的模块一律从这里取（lib/usage/time.mjs 的秒级工具也由它派生），不要各写一份
// `8 * 3600_000`，更不要用 getHours / setHours / new Date(y, m, d) 这类按本机时区取值的写法。
// 前端对应的那一份在 public/assets/js/render/usage-model.js（TZ_OFFSET_SEC），两边由
// beijing-time.test.mjs 钉成同一个值。
export const BEIJING_OFFSET_MS = 8 * 3600_000;

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

// epoch 毫秒 → 北京时间的 YYYY-MM-DD。
export function beijingDayKey(ms) {
  return ymd(new Date(ms + BEIJING_OFFSET_MS));
}

// 北京时间某天（YYYY-MM-DD）0 点的 epoch 毫秒。
export function beijingDayStartMs(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - BEIJING_OFFSET_MS;
}

// 北京时间某天结束（次日 0 点）的 epoch 毫秒。没有夏令时，一天恒为 24 小时。
export function beijingDayEndMs(day) {
  return beijingDayStartMs(day) + DAY_MS;
}

// 日期键 ± N 天（纯日历运算，与时区无关）。
export function offsetDay(day, days) {
  const [y, m, d] = day.split("-").map(Number);
  return ymd(new Date(Date.UTC(y, m - 1, d + days)));
}

// [startMs, endMs] 覆盖到的北京时间日期（含两端所在的那两天），旧 → 新，逐日不重不漏。
// 区间过长时在 maxDays 处截断（防御畸形入参，正常调用远小于它）。
export function beijingDaysBetween(startMs, endMs, maxDays = 400) {
  const days = [];
  const last = beijingDayKey(endMs);
  for (let day = beijingDayKey(startMs); days.length < maxDays; day = offsetDay(day, 1)) {
    days.push(day);
    if (day >= last) break;
  }
  return days;
}
