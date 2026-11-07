// 测试用：把同一段断言放到几个别的机器时区下各跑一遍（仅 *.test.mjs 与 scripts/test-tz.mjs 使用）。
//
// 背景：v2.45 起历史日文件、用量、简报、隧道稳定性、Slurm 的时刻一律按北京时间（lib/beijing-time.mjs），
// 但后来仍有代码按本机时区取年月日 / 时分，测试又用本机时间构造数据——开发机都在 UTC+8，
// 默认时区下 npm test 全绿，CI（UTC）红了一周没人发现。两道防线：
//   1. 断言里的时间用显式的 UTC+8 构造（Date.UTC(...) 减 8 小时，或带 +08:00 的字符串），期望值写死；
//   2. 口径敏感的用例再包一层 inEveryTimeZone——默认时区下跑 npm test 也能拦住「又用回了本机时区」。
// 整套测试换时区跑：`npm run test:tz`（scripts/test-tz.mjs，时区表取自这里）；CI 的 test 矩阵各带一个 TZ。
//
// 时区表的取法：UTC（CI 默认）、UTC+8 以西带夏令时的（洛杉矶）、非整点偏移（加尔各答，+5:30——
// 专拦「本机整点 = UTC 整点」的假设）、UTC+8 以东的（东京 +9；奥克兰 +12/+13，带夏令时、与北京隔着日界）。
export const TEST_TIME_ZONES = Object.freeze(["UTC", "America/Los_Angeles", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland"]);

function setZone(zone) {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone; // Node 在给 process.env.TZ 赋值时重置时区缓存，之后的 Date 即按新时区
}

// 依次在「原本的时区 + TEST_TIME_ZONES」下执行 fn(zone)（可以是 async），结束后还原。
// 只能用在串行执行的用例里（node:test 同一文件内默认串行）：TZ 是进程级状态，并发用例会互相踩。
export async function inEveryTimeZone(fn, zones = TEST_TIME_ZONES) {
  const original = process.env.TZ;
  const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    await fn(original ?? originalZone);
    for (const zone of zones) {
      setZone(zone);
      await fn(zone);
    }
  } finally {
    // 先显式设回原时区再还原变量：不依赖「删掉 TZ 就回到系统时区」在每个平台上都成立。
    setZone(originalZone);
    setZone(original);
  }
}
