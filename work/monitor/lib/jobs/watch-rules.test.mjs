import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSuggestions,
  createRuleMatcher,
  DEFAULT_RULES,
  globMatch,
  LONG_RUN_RULE,
  namePrefix,
  normalizeRules,
  patchRules,
  ruleKeys,
  ruleLabel,
  summarizeFailures,
  withoutRule,
} from "./watch-rules.mjs";

test("默认规则：失败提醒开、长作业关、没有名字规则；盘上坏掉的部分各自回到默认", () => {
  assert.deepEqual(normalizeRules(undefined), { failNotify: true, longRunMinutes: null, patterns: [] });
  assert.deepEqual(normalizeRules(DEFAULT_RULES), { failNotify: true, longRunMinutes: null, patterns: [] });
  assert.deepEqual(normalizeRules({ failNotify: false, longRunMinutes: 120, patterns: ["xp_*", "cfa-*-cfd1"] }), { failNotify: false, longRunMinutes: 120, patterns: ["xp_*", "cfa-*-cfd1"] });
  // 手改坏的文件：每一项单独判，合格的留下。
  assert.deepEqual(
    normalizeRules({ failNotify: "yes", longRunMinutes: 3, patterns: ["ok_*", " padded ", "", 7, "ok_*", "x".repeat(65), "a\nb"] }),
    { failNotify: true, longRunMinutes: null, patterns: ["ok_*"] },
  );
  assert.equal(normalizeRules({ patterns: Array.from({ length: 30 }, (_, i) => `p${i}_*`) }).patterns.length, 12);
  assert.deepEqual(normalizeRules([1, 2]), { failNotify: true, longRunMinutes: null, patterns: [] });
});

test("改规则：只带要改的字段，其余不动；名字规则去掉首尾空白", () => {
  const base = { failNotify: true, longRunMinutes: null, patterns: ["xp_*"] };
  assert.deepEqual(patchRules(base, { failNotify: false }), { failNotify: false, longRunMinutes: null, patterns: ["xp_*"] });
  assert.deepEqual(patchRules(base, { longRunMinutes: 90 }), { failNotify: true, longRunMinutes: 90, patterns: ["xp_*"] });
  assert.deepEqual(patchRules({ ...base, longRunMinutes: 90 }, { longRunMinutes: null }).longRunMinutes, null);
  assert.deepEqual(patchRules(base, { patterns: ["xp_*", "  cfa-*-cfd1 "] }).patterns, ["xp_*", "cfa-*-cfd1"]);
  assert.deepEqual(patchRules(base, { patterns: [] }).patterns, []);
  assert.deepEqual(base, { failNotify: true, longRunMinutes: null, patterns: ["xp_*"] }, "不改入参");
  // 中文名字按字符数算，不按 UTF-16 码元。
  assert.equal(patchRules(base, { patterns: [`${"算".repeat(63)}*`] }).patterns[0].length, 64);
});

test("改规则：加一条 / 删一条只动那一条（界面用这两个，免得把手里过时的整份列表盖回去）", () => {
  const base = { failNotify: true, longRunMinutes: 90, patterns: ["xp_*", "cfa-*"] };
  assert.deepEqual(patchRules(base, { addPattern: "  lora_* " }), { failNotify: true, longRunMinutes: 90, patterns: ["xp_*", "cfa-*", "lora_*"] });
  assert.deepEqual(patchRules(base, { addPattern: "xp_*" }).patterns, ["xp_*", "cfa-*"], "已经有的不重复加，也不报错");
  assert.deepEqual(patchRules(base, { removePattern: "xp_*" }).patterns, ["cfa-*"]);
  assert.deepEqual(patchRules(base, { removePattern: "missing_*" }).patterns, ["xp_*", "cfa-*"], "已经不在的当作删过了");
  assert.deepEqual(patchRules(base, { removePattern: "xp_*", addPattern: "xp_?" }).patterns, ["cfa-*", "xp_?"], "一删一加可以同一次");
  const full = { ...base, patterns: Array.from({ length: 12 }, (_, i) => `p${i}_*`) };
  assert.equal(patchRules(full, { addPattern: "p3_*" }).patterns.length, 12, "满了但加的是已有的：不算超");
  assert.equal(patchRules(full, { removePattern: "p0_*", addPattern: "new_*" }).patterns.length, 12, "先删后加，腾得出位置");
  const bad = [
    [full, { addPattern: "one_more_*" }, /最多 12 条/],
    [base, { addPattern: 5 }, /必须是文本/],
    [base, { addPattern: "   " }, /不能为空/],
    [base, { addPattern: "x".repeat(65) }, /最多 64 个字符/],
    [base, { addPattern: "a\nb" }, /控制字符/],
    [base, { removePattern: 7 }, /必须是文本/],
    [base, { patterns: ["a_*"], addPattern: "b_*" }, /不能同时/],
    [base, { patterns: ["a_*"], removePattern: "xp_*" }, /不能同时/],
  ];
  for (const [current, body, message] of bad) assert.throws(() => patchRules(current, body), (err) => err.status === 400 && message.test(err.message), JSON.stringify(body));
  assert.deepEqual(base.patterns, ["xp_*", "cfa-*"], "不改入参");
});

test("非法输入整次拒绝（400），不存半截", () => {
  const base = normalizeRules(null);
  const bad = [
    [{}, /未指定/],
    [{ action: "rules" }, /未指定/],
    [{ failNotify: "true" }, /开或关/],
    [{ failNotify: 1 }, /开或关/],
    [{ longRunMinutes: 9 }, /10–10080/],
    [{ longRunMinutes: 10081 }, /10–10080/],
    [{ longRunMinutes: 30.5 }, /10–10080/],
    [{ longRunMinutes: "60" }, /10–10080/],
    [{ longRunMinutes: 0 }, /10–10080/],
    [{ patterns: "xp_*" }, /必须是列表/],
    [{ patterns: Array.from({ length: 13 }, (_, i) => `p${i}`) }, /最多 12 条/],
    [{ patterns: ["ok", 5] }, /必须是文本/],
    [{ patterns: ["ok", "   "] }, /不能为空/],
    [{ patterns: ["x".repeat(65)] }, /最多 64 个字符/],
    [{ patterns: ["a\nb"] }, /控制字符/],
    [{ patterns: ["a\u0000b"] }, /控制字符/],
    [{ patterns: ["xp_*", " xp_* "] }, /重复：xp_\*/],
    // 合格的字段与不合格的字段一起来：整次不生效。
    [{ failNotify: false, patterns: [""] }, /不能为空/],
  ];
  for (const [body, message] of bad) {
    assert.throws(() => patchRules(base, body), (error) => error.status === 400 && message.test(error.message), JSON.stringify(body));
  }
});

test("通配：* 任意一段、? 一个字符、其余按字面并区分大小写，整名匹配", () => {
  const yes = [
    ["cfdauto_*", "cfdauto_setup_0412"], ["cfdauto_*", "cfdauto_"], ["cfa-*-cfd1", "cfa-agiter20-35607b-cfd1"], ["xp_?", "xp_a"],
    ["*", ""], ["*", "anything"], ["**", "x"], ["a*b*c", "a__b__c"], ["a*b*c", "abc"], ["train", "train"], ["*.sh", "run.sh"],
    ["算例_*", "算例_一号"], ["a?c", "a算c"], ["a.b", "a.b"], ["[x]", "[x]"], ["a+b(c)", "a+b(c)"],
  ];
  const no = [
    ["cfdauto_*", "xcfdauto_setup"], ["cfa-*-cfd1", "cfa-agiter20-35607b-cfd2"], ["xp_?", "xp_"], ["xp_?", "xp_ab"], ["train", "Train"],
    ["train", "train2"], ["a*b*c", "a__b__"], ["", "x"], ["a.b", "axb"], ["[x]", "x"], ["a+b", "aab"],
  ];
  for (const [pattern, name] of yes) assert.equal(globMatch(pattern, name), true, `${pattern} ~ ${name}`);
  for (const [pattern, name] of no) assert.equal(globMatch(pattern, name), false, `${pattern} !~ ${name}`);
  assert.equal(globMatch("", ""), true);
  assert.equal(globMatch("a*", null), false);
  // 名字里的 * 只是普通字符；规则里的 * 永远是通配。
  assert.equal(globMatch("a*", "a*b"), true);
  assert.equal(globMatch("a?b", "a*b"), true);
});

test("通配不回溯爆炸：32 个 * 对上 120 字符的不匹配名字也立刻有结果", () => {
  const pattern = `${"*a".repeat(31)}*b`;
  const name = "a".repeat(120);
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) assert.equal(globMatch(pattern, name), false);
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  // 转成正则的写法这里是指数级回溯（一次都跑不完）；这个写法 200 次也就几十毫秒，给机器卡顿留足余量。
  assert.ok(ms < 5000, `200 次用了 ${ms} ms`);
  assert.equal(globMatch(pattern, `${"a".repeat(119)}b`), true);
});

test("作业归哪条规则：名字规则按顺序先命中先得，其次长作业；排队中的不算长作业", () => {
  const rules = { failNotify: true, longRunMinutes: 120, patterns: ["cfa-*-cfd1", "cfa-*", "xp_*"] };
  assert.deepEqual(ruleKeys(rules), ["name:cfa-*-cfd1", "name:cfa-*", "name:xp_*", LONG_RUN_RULE]);
  assert.deepEqual(ruleKeys({ ...rules, longRunMinutes: null, patterns: [] }), []);
  const ruleOf = createRuleMatcher(rules);
  assert.equal(ruleOf({ name: "cfa-agiter20-35607b-cfd1", state: "RUNNING", elapsedSec: 9000 }), "name:cfa-*-cfd1");
  assert.equal(ruleOf({ name: "cfa-agiter20-35607b-mesh", state: "RUNNING", elapsedSec: 60 }), "name:cfa-*");
  assert.equal(ruleOf({ name: "xp_wallgate", state: "PENDING", elapsedSec: 0 }), "name:xp_*");
  assert.equal(ruleOf({ name: "other", state: "RUNNING", elapsedSec: 7200 }), LONG_RUN_RULE, "正好到阈值就算");
  assert.equal(ruleOf({ name: "other", state: "RUNNING", elapsedSec: 7199 }), null);
  assert.equal(ruleOf({ name: "other", state: "PENDING", elapsedSec: 0 }), null);
  assert.equal(ruleOf({ name: "other", state: "COMPLETED", elapsedSec: 8000 }), LONG_RUN_RULE, "结束了的长作业也归它（这一批结束的计数用）");
  assert.equal(ruleOf({ name: null, state: "RUNNING", elapsedSec: null }), null);
  assert.equal(ruleOf(null), null);
  assert.equal(createRuleMatcher(normalizeRules(null))({ name: "x", state: "RUNNING", elapsedSec: 1e9 }), null, "默认规则不自动关注任何作业");
  assert.equal(ruleLabel("name:cfa-*", rules), "cfa-*");
  assert.equal(ruleLabel(LONG_RUN_RULE, rules), "运行超过 120 分钟的作业");
  assert.deepEqual(withoutRule(rules, "name:cfa-*").patterns, ["cfa-*-cfd1", "xp_*"]);
  assert.equal(withoutRule(rules, LONG_RUN_RULE).longRunMinutes, null);
  assert.deepEqual(withoutRule(rules, "name:missing"), rules);
});

test("建议前缀：去掉末尾的数字 / 日期 / 哈希段（哈希后的阶段后缀一并去掉）", () => {
  const cases = [
    ["cfdauto_setup_0412", "cfdauto_setup"],
    ["cfdauto_mesh_20261009_ab12cd", "cfdauto_mesh"],
    ["cfa-agiter20-35607b-cfd1", "cfa-agiter20"],
    ["sweep_lr_12", "sweep_lr"],
    ["xp_wallgate_s1", "xp_wallgate_s1"],
    ["run_2026_10_09", "run"],
    ["train.20261009T153000", "train"],
    ["train", "train"],
    ["  padded_7  ", "padded"],
    ["agiter20", "agiter20"],
  ];
  for (const [name, prefix] of cases) assert.equal(namePrefix(name), prefix, name);
  for (const name of ["", "x", "7", "12345", "35607b", "20261009T1530", "a_1", null, undefined, `${"y".repeat(70)}_1`, "we?rd_1", "st*r_2"]) assert.equal(namePrefix(name), null, String(name));
});

test("建议：近期作业名按前缀计数取前 8 个；已有规则管着的不再建议；同一作业、同一数组只算一次", () => {
  const entries = [];
  const add = (name, count) => { for (let i = 0; i < count; i += 1) entries.push({ id: String(1001 + entries.length), name: `${name}_${String(i).padStart(4, "0")}` }); };
  add("cfdauto_setup", 30);
  add("cfdauto_mesh", 20);
  add("xp_wallgate", 5);
  for (const [i, tag] of ["a1b2c3", "d4e5f6", "0a0b0c"].entries()) entries.push({ id: String(5000 + i), name: `cfa-agiter20-${tag}-cfd1` });
  // 登记表与快照里是同一个作业；数组的整体记录与各个任务是同一次提交。
  entries.push({ id: "1001", name: "cfdauto_setup_0000" }, { id: "7000_[1-9]", name: "arr_1" }, { id: "7000_3", name: "arr_1" }, { id: "7000_4", name: "arr_1" });
  entries.push({ id: "bad", name: "ignored_1" }, { id: "8000", name: null }, { id: "8001", name: "" }, null);
  const all = buildSuggestions(entries, normalizeRules(null));
  assert.deepEqual(all, [
    { prefix: "cfdauto_setup", pattern: "cfdauto_setup*", count: 30 },
    { prefix: "cfdauto_mesh", pattern: "cfdauto_mesh*", count: 20 },
    { prefix: "xp_wallgate", pattern: "xp_wallgate*", count: 5 },
    { prefix: "cfa-agiter20", pattern: "cfa-agiter20*", count: 3 },
    { prefix: "arr", pattern: "arr*", count: 1 },
  ]);
  const withRule = buildSuggestions(entries, normalizeRules({ patterns: ["cfdauto_*"] }));
  assert.deepEqual(withRule.map((s) => s.prefix), ["xp_wallgate", "cfa-agiter20", "arr"]);
  const many = buildSuggestions(Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), name: `exp${String.fromCharCode(97 + i)}_1` })), normalizeRules(null));
  assert.equal(many.length, 8);
  assert.deepEqual(many.map((s) => s.prefix).slice(0, 2), ["expa", "expb"], "同数按名字排，结果稳定");
  assert.deepEqual(buildSuggestions([], normalizeRules(null)), []);
});

test("建议前缀的两个怪例（2026-10-12 审查）：纯字母的十六进制段是单词不是哈希；个数是这条规则会命中的作业数", () => {
  // added / faded 是单词：不能把它连同后面的一起当哈希后缀砍掉，否则 xp_added_noise_1 只剩 xp、建议出一条过宽的 xp*。
  assert.equal(namePrefix("xp_added_noise_1"), "xp_added_noise");
  assert.equal(namePrefix("run-faded-edges-3"), "run-faded-edges");
  assert.equal(namePrefix("cfa-agiter20-35607b-cfd1"), "cfa-agiter20", "带数字的哈希照旧连同阶段后缀去掉");
  assert.equal(namePrefix("sweep_20261009_lr"), "sweep", "日期段之后的也照旧去掉");
  assert.equal(namePrefix("cfa-added-35607b-cfd1"), "cfa-added", "单词段留着，后面真的哈希照去");
  assert.equal(namePrefix("exp_decade"), "exp_decade");
  assert.equal(namePrefix("_35607b"), null, "去完什么都不剩的不建议");
  // xp_base 这个名字本身只有 2 个，但规则 xp_base* 还会命中 xp_base_wide_* 的 5 个：个数写 7 而不是 2。
  const entries = [];
  const add = (name, count) => { for (let i = 0; i < count; i += 1) entries.push({ id: String(1001 + entries.length), name: `${name}_${i}` }); };
  add("xp_base", 2);
  add("xp_base_wide", 5);
  add("other", 3);
  assert.deepEqual(buildSuggestions(entries, normalizeRules(null)), [
    { prefix: "xp_base", pattern: "xp_base*", count: 7 },
    { prefix: "xp_base_wide", pattern: "xp_base_wide*", count: 5 },
    { prefix: "other", pattern: "other*", count: 3 },
  ]);
  // 已有规则管着的名字归先命中的那条，不算进别的建议的个数里。
  assert.deepEqual(buildSuggestions(entries, normalizeRules({ patterns: ["xp_base_wide*"] })).map((s) => [s.prefix, s.count]), [["other", 3], ["xp_base", 2]]);
});

test("失败提醒文案：按原因汇总并带作业号；有诊断用诊断，没有的按 sacct 状态说", () => {
  const diagnoses = new Map([
    ["18765", { category: "python", headline: "KeyError: 'arm'" }],
    ["18766", { category: "python", headline: "KeyError: 'arm'" }],
    ["18770", { category: "timeout", headline: "超出时限（已运行 2 小时）" }],
  ]);
  const of = (id) => diagnoses.get(id) ?? null;
  const job = (id, state = "FAILED", extra = {}) => ({ id, name: `train_${id}`, state, exitCode: 1, endAt: Number(id), ...extra });
  const three = summarizeFailures([job("18770", "TIMEOUT"), job("18766"), job("18765")], of);
  assert.equal(three.title, "3 个作业失败");
  assert.equal(three.body, "2 个 KeyError: 'arm'，1 个超出时限。作业号 18770、18766、18765。详情见「我的历史」。");

  const one = summarizeFailures([job("18765")], of);
  assert.equal(one.title, "作业失败：train_18765");
  assert.equal(one.body, "KeyError: 'arm'。作业号 18765。详情见「我的历史」。");

  // 诊断还没取回来：超时 / 内存不足 / 节点故障照状态说（能与已诊断的同因合并），其余写退出码并说明待查。
  const pending = summarizeFailures([job("1", "TIMEOUT"), job("18770", "TIMEOUT"), job("2", "OUT_OF_MEMORY"), job("3", "NODE_FAIL"), job("4", "FAILED", { exitCode: 2 }), job("5", "FAILED", { exitCode: null })], of);
  assert.equal(pending.title, "6 个作业失败");
  assert.match(pending.body, /^2 个超出时限，/);
  assert.match(pending.body, /另有 \d 个是其它 \d 种原因/);
  assert.match(summarizeFailures([job("4", "FAILED", { exitCode: 2 })]).body, /^退出码 2，原因待查。作业号 4。/);
  assert.match(summarizeFailures([job("5", "FAILED", { exitCode: null, name: null })]).title, /^作业失败：5$/);

  // 很多个：作业号只列前几个，原因只列前三种，长标题截短。
  const many = Array.from({ length: 40 }, (_, i) => job(String(100 + i), "FAILED", { exitCode: i % 5 }));
  const long = summarizeFailures(many, (id) => ({ category: "python", headline: `${"长".repeat(200)} ${Number(id) % 5}` }));
  assert.equal(long.title, "40 个作业失败");
  assert.match(long.body, /作业号 100、101、102、103、104、105 等 40 个。/);
  assert.ok(long.body.length < 400, `正文 ${long.body.length} 字`);
});
