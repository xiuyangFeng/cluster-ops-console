// 接入管理（配置 →「接入引导」下面）：这个账号在集群登记目录里名下的端口、释放闲置端口、撤销接入。
// 撤销是命令行 `npm run setup:undo` 的界面版——同一份编排（./undo.mjs）、同一批命令（cluster-env.mjs 的
// buildUndoCommands 与 port-registry.mjs 的 buildReleaseCommand），只换执行器与确认方式。
//
// 范围：只对团队集群那一台（TEAM_PRIMARY_SERVER_ID，与接入引导同一台）；密码连接的服务器不支持。
// SSH 全部经调度器槽位，只在用户打开配置或点了按钮时才发，没有定时采集。
//
// 四个动作：
//   getAccess    读。本机已知的事实立刻返回；端口登记要 SSH 去读，过期时在后台读一轮（registry.pending），
//                界面隔一秒再取。读到的结果缓存一分钟。
//   releasePort  释放一个闲置的登记端口。先重新读一遍登记与监听：这台电脑在用的（合并后生效的那个）、正在
//                被监听的、不在自己名下的一律拒绝——在用的端口只能随撤销一起释放。个人配置里要是还留着它的
//                旧记录（改过端口后被盖住、没在生效的那条），先把那条清掉再放登记。
//   previewUndo  只读预览（等同 --dry-run），外加看一眼集群上现在有哪些受管内容（./undo-survey.mjs）。
//                给出 previewId，十分钟内有效；撤销必须带着它来。
//   runUndo      确认后执行。后台逐步做，任何一步没做成就停在那里；进度随 getAccess 的 undo 字段给出。
//                执行期间占用 CLI 任务锁（安装 / 登录也会改 env.sh 与 keys/，不能同时进行）。
//                做成后把接入引导的进度清掉（"已接入"不再成立）并记成「稍后再说」——刚撤销完不该自己弹出来。
// 同一时刻只做一个动作；接入引导正在执行步骤时不做，反过来撤销期间引导的写接口由路由层挡住（busyNotice）。
//
// 个人配置只经注入的 savePersonalConfig 写（与设置页同一条路：校验、.bak、revision）。
// fixture 模式（冒烟 / 界面预览）不发 SSH、不写任何文件：同一套编排跑在一个假的远端上。
import { randomBytes } from "node:crypto";

import { busyMessage } from "../cli/task-lock.mjs";
import {
  CLAUDE_SETTINGS_FILE,
  CLAUDE_SETTINGS_READ_COMMAND,
  CLUSTER_ENV_DIR,
  CLUSTER_ENV_PATH,
  mergeClaudeSettingsEnv,
  noProxyExtraFor,
  STRAY_DISABLED_PREFIX,
} from "../cluster-env.mjs";
import { previousPersonalRemotePorts, validatePersonalServersForWrite, validatePortOverridesForWrite } from "../config-loader.mjs";
import { TEAM_PRIMARY_SERVER_ID } from "../onboarding.mjs";
import { REVERSE_PORT_BASE } from "../reverse-port.mjs";
import {
  buildRegistrySurveyCommand,
  buildReleaseCommand,
  ownRegisteredPorts,
  parseRegistrySurvey,
  parseReleaseResult,
  registeredOwnerOf,
  resolvePortRegistryDir,
} from "../port-registry.mjs";
import { sanitizeEntry } from "../servers/validate.mjs";
import { attachPersonalSsh, classifySshFailure } from "../ssh-args.mjs";
import { statusError } from "../status-error.mjs";
import { toPort } from "../validators.mjs";
import { leftoverItems, planUndoSteps, UNDO_SSH_READ_TIMEOUT_MS, UNDO_SSH_WRITE_TIMEOUT_MS, undoClusterSetup } from "./undo.mjs";
import { buildUndoSurveyCommand, parseUndoSurvey, UNDO_SURVEY_DONE } from "./undo-survey.mjs";

// 端口登记读到之后的有效期：配置浮层反复开合不重复发 SSH。
export const ACCESS_REGISTRY_TTL_MS = 60000;
// 预览的有效期：隔太久再点确认，集群上的东西可能已经变了。
export const UNDO_PREVIEW_TTL_MS = 10 * 60000;

// 预览里每类最多列这么多条，其余只报个数。
const MAX_LISTED = 8;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

// 把这台团队服务器的反向端口从个人层拿掉 → 交给 savePersonalConfig 的补丁；没有可拿的返回 null。
// 端口可能记在两处：portOverrides[serverId]（命令行向导写的）与 servers 里同 id 的覆盖条目（界面里领的、
// 「重新分配端口」写的；两处都有时后者生效，前者只是被盖住的旧记录）。
//   不给 port  两处都拿（撤销并释放：隧道必须停下来）；
//   给了 port  只拿等于它的那一处（释放一个闲置端口时清掉它留在配置里的旧记录，生效的那个不动）。
// 只拿 remotePort：localPort 决定本机代理监听哪个端口，所有隧道共用它，撤销一台服务器不该让别的隧道跟着
// 换代理端口。覆盖条目拿掉端口后只剩 id 的，整条去掉。
// servers 整体带回时其余条目照服务器登记表的做法先剥掉不该落盘的字段（sanitizeEntry）。
export function buildDropPortPatch(personal, serverId, { port = null } = {}) {
  const wanted = (entry) => isPlainObject(entry) && Object.hasOwn(entry, "remotePort") && (port === null || toPort(entry.remotePort) === port);
  const patch = {};
  const overrides = personal?.portOverrides;
  if (isPlainObject(overrides) && wanted(overrides[serverId])) {
    const { remotePort: _dropped, ...rest } = overrides[serverId];
    const next = { ...overrides };
    if (Object.keys(rest).length) next[serverId] = rest;
    else delete next[serverId];
    patch.portOverrides = next;
  }
  const servers = Array.isArray(personal?.servers) ? personal.servers : [];
  const hit = (entry) => isPlainObject(entry) && entry.id === serverId && wanted(entry);
  if (servers.some(hit)) {
    patch.servers = servers.flatMap((entry) => {
      if (!hit(entry)) return [sanitizeEntry(entry)];
      const { remotePort: _dropped, ...rest } = entry;
      return Object.keys(rest).length > 1 ? [rest] : [];
    });
  }
  return Object.keys(patch).length ? patch : null;
}

// 个人层（磁盘上那一份）此刻让这台服务器用哪个端口：同 id 的 servers 覆盖条目优先，其次 portOverrides——
// 与 config-loader 的合并顺序一致。个人层没记端口 → null。
// 合并后的配置是进程里的缓存，命令行向导、手改个人配置都不经过这个进程，缓存最长会晚一分钟跟上；
// 判断「这台电脑在不在用这个端口」时两边都要看。
export function effectivePersonalPort(personal, serverId) {
  const servers = Array.isArray(personal?.servers) ? personal.servers : [];
  for (const entry of servers) {
    if (!isPlainObject(entry) || entry.id !== serverId) continue;
    const port = toPort(entry.remotePort);
    if (port !== null) return port;
  }
  const overrides = personal?.portOverrides;
  return isPlainObject(overrides) && isPlainObject(overrides[serverId]) ? toPort(overrides[serverId].remotePort) : null;
}

// 校验没过时逐字段的原因（ConfigValidationError.errors）→ 一句话；最多带三条。
function fieldErrorsText(errors) {
  const list = (Array.isArray(errors) ? errors : []).filter((item) => item?.message);
  const shown = list.slice(0, 3).map((item) => (item.field ? `${item.field}：${item.message}` : item.message));
  return `${shown.join("；")}${list.length > shown.length ? ` 等 ${list.length} 处` : ""}`;
}

// 个人配置没写成的原因：校验类错误把是哪个字段、为什么一起带上（只说「未通过校验」没法照着改）。
export function describeConfigError(error) {
  const message = error?.message || "个人配置没有写成";
  const detail = fieldErrorsText(error?.errors);
  return detail ? `${message}（${detail}）` : message;
}

const SSH_FAILURE_TEXT = Object.freeze({
  timeout: "连接服务器超时，当前网络可能不在集群的 SSH 白名单内",
  refused: "服务器拒绝了连接，当前网络可能不在集群的 SSH 白名单内",
  dns: "找不到这台服务器，检查本机网络是否正常",
  auth: "登录服务器失败，用户名或密钥不对",
  hostkey: "服务器指纹和之前保存的不一致",
  "rate-limit": "尝试次数过多，服务器暂时拒绝连接，等几分钟再试",
});

// 给人看之前：控制字符换掉；代理地址里的账号口令不显示。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 远端原文里的控制字符就是要挡掉的
const printable = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
const redactUserinfo = (text) => printable(text).replace(/(:\/\/)[^/@\s"']+@/g, "$1***@");

// 一次没成的远端命令 → { code, message }。认得出的原因说人话，认不出的给 ssh 的最后一行原话
// （会显示在界面上、记进日志：控制字符换掉，地址里的账号口令不带出来）。
export function describeRemoteFailure(text, { timedOut = false, exitCode = null } = {}) {
  if (timedOut) return { code: "timeout", message: SSH_FAILURE_TEXT.timeout };
  // 只有 ssh 自己没连上 / 没登进去才按连接问题归类（ssh 的退出码是 255；没有退出码 = 进程没起来或被杀）。
  // 命令已经在服务器上跑了、是它自己失败的（退出码 1–254），原因在它的输出里——那里的 "Permission denied"
  // 是文件权限，不是登录失败。
  const sshLevel = exitCode == null || exitCode === 255;
  const known = sshLevel ? classifySshFailure(text)?.code : null;
  if (known && SSH_FAILURE_TEXT[known]) return { code: known, message: SSH_FAILURE_TEXT[known] };
  const last = redactUserinfo(String(text || "").trim().split(/\r?\n/).filter((line) => line.trim()).at(-1) || "").trim();
  return { code: "unknown", message: last.slice(0, 300) || (exitCode === 0 ? "服务器没有给出完整的结果" : `ssh 退出码 ${exitCode ?? "未知"}`) };
}

const STEP_TITLE = Object.freeze({
  "strip-source-blocks": "删除 shell 启动文件里引入代理配置的那几行",
  "remove-env": `删除 ~/${CLUSTER_ENV_DIR}/ 里的代理配置与保存的 API key`,
  "restore-strays": "恢复接入时被注释掉的旧代理设置",
  "claude-settings": `从 ~/${CLAUDE_SETTINGS_FILE} 里删除工作台写入的代理设置`,
});
const stepTitle = (step) => STEP_TITLE[step.id] || step.title;
const releaseTitle = (port) => `释放端口登记 ${port}`;
const localPortTitle = (port) => `从这台电脑的配置里拿掉端口 ${port}`;

// settings.json 那一步被跳过的原因（planClaudeSettingsRemoval 的 reason）。
const SETTINGS_SKIP_TEXT = Object.freeze({
  "no-claude": "集群上没有 Claude Code，无需处理",
  "invalid-json": "文件不是合法的 JSON，保持不动，请自行检查",
});

const NOTHING_FOUND = "没有发现，这一步不会改动任何东西";

function listed(items, unit) {
  return items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `另有 ${items.length - MAX_LISTED} ${unit}`] : items;
}

// 预览里的一步：{ id, title, effect: "change" | "none", items, note }。
// found 是 undo-survey 看到的现状，outcome 是编排 dry-run 给出的这一步结果（settings.json 那一步要看它）。
function previewStep(step, found, outcome) {
  const base = { id: step.id, title: stepTitle(step), effect: "change", items: [], note: "" };
  const none = (note = NOTHING_FOUND) => ({ ...base, effect: "none", note });
  if (step.id === "strip-source-blocks") {
    return found.blocks.length ? { ...base, items: found.blocks.map((file) => `~/${file}`) } : none();
  }
  if (step.id === "remove-env") {
    const items = [];
    if (found.envFile) items.push(`~/${CLUSTER_ENV_PATH}`);
    if (found.keys.length) {
      const names = found.keys.slice(0, MAX_LISTED).map(printable);
      items.push(`keys/ 里的 ${found.keys.length} 个文件（${names.join("、")}${found.keys.length > names.length ? " 等" : ""}），是登录时保存的 API key`);
    }
    return items.length ? { ...base, items } : none();
  }
  if (step.id === "restore-strays") {
    const items = found.strays.map((stray) => `~/${stray.file} 第 ${stray.line} 行：${redactUserinfo(stray.text)}`);
    return items.length ? { ...base, items: listed(items, "行") } : none();
  }
  if (step.kind === "settings-edit") {
    if (outcome?.status === "dry-run") return { ...base, items: outcome.changedKeys || [] };
    if (outcome?.status === "skipped") return none(SETTINGS_SKIP_TEXT[outcome.reason] || "已跳过，保持不动");
    return none("里面没有工作台写入的代理设置，无需改动");
  }
  // 以后 buildUndoCommands 多出来的步骤：这里不认识它，照它自己的标题列出来。
  return base;
}

// 撤销执行中一个进度事件 → 这一步现在的 { status, detail, manual }。
// status: "running" | "ok" | "skipped"（无需处理 / 保持不动）| "failed"
function stepOutcome(event) {
  if (event.status === "running") return { status: "running", detail: "", manual: "" };
  if (event.phase === "release") {
    if (event.status === "ok") return { status: "ok", detail: "登记已删除", manual: "" };
    if (event.status === "absent") return { status: "skipped", detail: "登记目录里没有这个端口的登记，无需释放", manual: "" };
    if (event.status === "not-owner") return { status: "skipped", detail: "登记在别人名下，没有动那份登记", manual: "" };
    // 服务器明确回了「没删成」（命令跑完了，退出码 0）：登记还在。
    if (event.status === "failed" && event.exitCode === 0) return { status: "failed", detail: "服务器上的登记文件没有删掉，登记还在；这台电脑的配置没有改动", manual: "" };
    // 其余是没有结论：超时、连接中途断了、没看到结果行——删登记的那条命令可能已经执行了。不说成「没有改动」。
    const reason = describeRemoteFailure(event.error, { exitCode: event.exitCode }).message;
    return { status: "failed", detail: `${reason}。登记可能已经删掉，也可能没有；这台电脑的配置没有改动`, manual: "" };
  }
  if (event.phase === "local-port") {
    if (event.status === "ok") return { status: "ok", detail: "隧道会在几秒内停止", manual: "" };
    if (event.status === "unchanged") return { status: "skipped", detail: "配置里已经没有这个端口", manual: "" };
    // 走到这一步，这个端口已经不该再用了（登记放掉了，或本来就不在自己名下），本机却还留着它。
    return { status: "failed", detail: `${event.error || "个人配置没有写成"}。这台电脑的配置里还留着这个端口，隧道还在往上面建：先在首页「停止所有连接」，修好个人配置后再撤销一次`, manual: "" };
  }
  if (event.status === "ok") return { status: "ok", detail: event.changedKeys?.length ? `已删除 ${event.changedKeys.join("、")}` : "", manual: "" };
  if (event.status === "unchanged") return { status: "skipped", detail: "里面没有工作台写入的代理设置，无需改动", manual: "" };
  if (event.status === "skipped") return { status: "skipped", detail: SETTINGS_SKIP_TEXT[event.reason] || "已跳过，保持不动", manual: "" };
  return { status: "failed", detail: describeRemoteFailure(event.error, { exitCode: event.exitCode }).message, manual: event.manual || "" };
}

const UNAVAILABLE_TEXT = Object.freeze({
  "no-team-server": "团队配置里没有集群服务器",
  disabled: "这台电脑已选择不接入这个集群",
  "password-auth": "密码连接的服务器不支持在这里管理接入",
  "personal-config": "个人配置读不出来，请先修复它",
  "not-connected": "这台电脑还没有接入集群",
});

// 团队最早的生产端口（7891）放掉就拿不回来：领取的候选永远不含它，个人配置也不许新写它（config-loader 的写入
// 守卫只放行"原本就是它"）。释放之前要把这一点说清楚。
const BASE_PORT_NOTE = `${REVERSE_PORT_BASE} 是团队最早的生产端口：放掉之后工作台不会再把它分给任何人（包括你），重新接入只能领到新的端口。`;

// 正在做的那一个动作叫什么（拼进"……，等它结束再操作"）。
const BUSY_LABEL = Object.freeze({ release: "正在释放端口", preview: "正在读取集群上的配置", undo: "正在撤销接入" });
const busyLabel = (current) => BUSY_LABEL[current?.kind] || "正在处理上一个操作";

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export function createAccessManager({
  fixtureMode = false,
  getConfig,
  getPersonalConfig = () => ({}),
  savePersonalConfig,
  refreshConfigIntoKernel = async () => {},
  // (server, config, command, { timeoutMs, input }) → { code, stdout, stderr, timedOut }：与探针同一套钉扎参数与执行入口。
  runRemote,
  acquireSshSlot = null,
  // lib/cli/task-lock.mjs 的共用实例（安装 / 回滚 / 登录用的同一把）。
  taskLock = null,
  // 接入引导（./service.mjs）：正在执行步骤时不动；撤销做成后清掉它的进度。
  onboardingGuide = null,
  // 一次撤销结束后调用（做成、半途停下都算——keys/ 里的 API key 可能已经删了）：让 CLI 的登录状态重测一遍。
  onClusterChanged = () => {},
  // 团队配置 → 端口登记目录。给不出目录（写坏了又不许回落默认）时返回假值：这里只读不放，绝不改用别的目录。
  resolveRegistryDir = resolvePortRegistryDir,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newId = () => randomBytes(8).toString("hex"),
  log = () => {},
} = {}) {
  // 正在做的那一个动作：{ kind: "release" | "preview" | "undo", port? }
  let busy = null;
  // 最近一次读到的端口登记：{ serverId, at, data: { state, dir, survey, error } }
  let registry = null;
  let registryInFlight = null;
  // 登记有变（释放 / 撤销 / 动作里的重读）时 +1：在那之前发出的后台读晚到了不采用。
  let generation = 0;
  // 最近一次预览：{ id, serverId, port, createdAt, releaseAvailable, releaseNote, registryDir }。用一次就作废。
  let preview = null;
  // 最近一次撤销（进行中或已结束），进程重启即丢——各步幂等，没做完的再撤销一次。
  let job = null;
  // 当前这一次撤销的执行（测试等它；生产代码不等）。
  let currentRun = Promise.resolve();

  const simulation = fixtureMode ? createSimulation() : null;

  // ---- fixture 模式：一个假的远端。命令还是真实生成的那几条，只是回话是编的 ----
  function createSimulation() {
    const sim = { me: "amy", port: 7892, own: [7892, 7895], undone: false };
    const ok = (lines) => ({ code: 0, stdout: `${[].concat(lines).join("\n")}\n`, stderr: "", timedOut: false });
    async function remote(config, command) {
      await sleep(350);
      const dir = resolveRegistryDir(config);
      if (command === buildRegistrySurveyCommand(dir)) {
        return ok([
          "REGISTRY=ok",
          "STICKY=1",
          ...sim.own.map((port) => `REG\t${port}\t${sim.me}\tf`),
          "REG\t7893\tsimple\tf",
          `ME=${sim.me}`,
          "LISTEN-BEGIN",
          ...(sim.port ? [`LISTEN 0 128 127.0.0.1:${sim.port} 0.0.0.0:*`] : []),
          "LISTEN-END",
        ]);
      }
      if (command === buildUndoSurveyCommand()) {
        if (sim.undone) return ok(["ENV=0", UNDO_SURVEY_DONE]);
        return ok(["BLOCK\t.bashrc", "BLOCK\t.bash_profile", `STRAY\t.bashrc\t145\t${STRAY_DISABLED_PREFIX}export http_proxy=http://127.0.0.1:7890`, "ENV=1", "KEY\tcodex-relay.env", UNDO_SURVEY_DONE]);
      }
      if (command === CLAUDE_SETTINGS_READ_COMMAND) {
        const text = sim.undone || !sim.port ? "{}\n" : mergeClaudeSettingsEnv("{}", { port: sim.port }).text;
        return ok(`__CWB_CLAUDE__=1\n${text}`.trimEnd());
      }
      for (const port of sim.own) {
        if (command !== buildReleaseCommand(dir, port)) continue;
        sim.own = sim.own.filter((item) => item !== port);
        return ok("RELEASE=ok");
      }
      // 其余是撤销的几条写命令：假装做成。
      return ok([]);
    }
    return { sim, remote };
  }

  // ---- 目标与上下文 ----

  // → { config, server, personal, port, reason }；reason 非空 = 现在没有可管理的东西（界面整块不显示）。
  async function resolveContext() {
    const config = await getConfig();
    const server = (config?.servers || []).find((item) => item?.id === TEAM_PRIMARY_SERVER_ID && item.source !== "personal") || null;
    const base = { config, server, personal: {}, port: null };
    if (!server) return { ...base, reason: "no-team-server" };
    if (server.disabled === true) return { ...base, reason: "disabled" };
    if (simulation) return { ...base, port: simulation.sim.port, reason: null };
    if (server.authRef) return { ...base, reason: "password-auth" };
    let personal;
    try {
      personal = getPersonalConfig() || {};
    } catch {
      return { ...base, reason: "personal-config" };
    }
    const port = toPort(server.remotePort);
    // 还没接入过（没有端口，也没记下集群账号）：没有可管理的东西，也不为此去连服务器。
    if (port === null && !attachPersonalSsh(server, config).sshUser) return { ...base, personal, reason: "not-connected" };
    return { ...base, personal, port, reason: null };
  }

  async function requireContext(serverId) {
    const ctx = await resolveContext();
    if (serverId != null && serverId !== ctx.server?.id) throw statusError("只能管理团队集群那一台服务器，请刷新页面", 409, { code: "server-mismatch" });
    if (ctx.reason) throw statusError(UNAVAILABLE_TEXT[ctx.reason] || "现在不能管理接入", 409, { code: ctx.reason });
    return ctx;
  }

  function assertFree() {
    if (busy) throw statusError(`${busyLabel(busy)}，等它结束再操作`, 409, { code: "busy" });
    if (onboardingGuide?.getBrief?.().busy === true) throw statusError("接入引导正在执行步骤，等它停下来再操作", 409, { code: "guide-busy" });
  }

  // 发一条远端命令。永不抛错：执行器抛的折成 { code: null, stderr }。
  async function remote(ctx, command, options = {}) {
    if (simulation) return simulation.remote(ctx.config, command);
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: ctx.server.host }) : null;
    try {
      return (await runRemote(ctx.server, ctx.config, command, options)) || { code: null, stdout: "", stderr: "", timedOut: false };
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error), timedOut: false };
    } finally {
      if (typeof release === "function") release();
    }
  }

  const remoteOk = (res) => res?.code === 0 && !res.timedOut;
  const failureOf = (res) => describeRemoteFailure(res?.stderr, { timedOut: res?.timedOut === true, exitCode: res?.code ?? null });

  // 编排（./undo.mjs）要的执行器形状：{ status, stdout, stderr }。超时写成一句能直接给人看的话。
  const sshFor = (ctx) => async (_host, command, options = {}) => {
    const res = await remote(ctx, command, options);
    if (res?.timedOut) return { status: null, stdout: res.stdout || "", stderr: `SSH 未在 ${Math.round((options.timeoutMs || 0) / 1000)} 秒内返回` };
    return { status: res?.code ?? null, stdout: res?.stdout || "", stderr: res?.stderr || "" };
  };

  // ---- 端口登记 ----

  // → { state: "ok" | "absent" | "readonly" | "unknown" | "invalid", dir, survey, error }
  async function readRegistry(ctx) {
    const dir = resolveRegistryDir(ctx.config);
    if (!dir) return { state: "invalid", dir: null, survey: null, error: { code: "invalid-dir", message: "团队配置里的端口登记目录写得不对" } };
    const res = await remote(ctx, buildRegistrySurveyCommand(dir), { timeoutMs: UNDO_SSH_READ_TIMEOUT_MS });
    const survey = remoteOk(res) ? parseRegistrySurvey(res.stdout) : null;
    // 没看到 REGISTRY 行 = 这次没读到（目录可能在）：不当成"没有登记"。
    if (!survey || survey.registry === "unknown") return { state: "unknown", dir, survey: null, error: failureOf(res) };
    return { state: survey.registry, dir, survey, error: null };
  }

  const cachedRegistry = (ctx) => (registry && registry.serverId === ctx.server.id ? registry : null);

  function storeRegistry(ctx, data) {
    generation += 1;
    registry = { serverId: ctx.server.id, at: now(), data };
    return data;
  }

  // 后台读一轮（并发的请求合并成一次 SSH）。动作里的重读走 readRegistry + storeRegistry，不经这里。
  function refreshRegistry(ctx) {
    if (registryInFlight) return registryInFlight;
    const startedAt = generation;
    const promise = readRegistry(ctx)
      // 读的过程自己出了错（不该发生）：如实记成没读到，不留一个永远"读取中"或空白的状态。
      .catch((error) => ({ state: "unknown", dir: null, survey: null, error: { code: "unknown", message: String(error?.message || error) } }))
      .then((data) => {
        if (startedAt === generation) registry = { serverId: ctx.server.id, at: now(), data };
      })
      .finally(() => {
        if (registryInFlight === promise) registryInFlight = null;
      });
    registryInFlight = promise;
    return promise;
  }

  function registryView(ctx, entry) {
    const pending = Boolean(registryInFlight);
    const data = entry?.data || null;
    const view = { state: data?.state || "unknown", dir: data?.dir || null, me: data?.survey?.me || "", ports: [], current: null, error: data?.error || null, checkedAt: entry?.at ?? null, pending };
    const survey = data?.survey;
    if (!survey) return view;
    const own = ownRegisteredPorts(survey);
    // 在用 = 合并后的配置里生效的那个端口（隧道建在它上面），加上磁盘上的个人配置此刻指的那个
    // （刚在别处改过端口、这个进程还没重载时两者不同——两个都算在用，宁可多拦）。被盖住的旧记录不算。
    const live = effectivePersonalPort(ctx.personal, ctx.server.id);
    view.ports = own.map((port) => {
      const current = port === ctx.port || port === live;
      const listening = survey.listening.includes(port);
      return { port, current, listening, releasable: data.state === "ok" && !current && !listening, ...(port === REVERSE_PORT_BASE ? { base: true } : {}) };
    });
    // 这台电脑在用的端口在登记目录里归谁："me" | "other" | "none"（没有登记）。
    if (ctx.port != null) {
      const owner = registeredOwnerOf(survey, ctx.port);
      if (own.includes(ctx.port)) view.current = { port: ctx.port, owner: "me", name: survey.me };
      else if (owner !== null) view.current = { port: ctx.port, owner: "other", name: owner };
      else view.current = { port: ctx.port, owner: "none", name: "" };
    }
    return view;
  }

  const jobView = () => (job ? structuredClone(job) : null);

  function buildView(ctx) {
    if (ctx.reason) {
      return { available: false, reason: ctx.reason, simulated: Boolean(simulation), server: null, port: null, registry: null, busy: null, undo: jobView() };
    }
    return {
      available: true,
      reason: null,
      simulated: Boolean(simulation),
      server: { id: ctx.server.id, name: ctx.server.name || ctx.server.id, host: ctx.server.host },
      port: ctx.port,
      registry: registryView(ctx, cachedRegistry(ctx)),
      busy: busy ? { ...busy } : null,
      undo: jobView(),
    };
  }

  // 读。fresh：跳过缓存重读一轮（界面上的「重试」）。
  async function getAccess({ fresh = false } = {}) {
    const ctx = await resolveContext();
    if (ctx.reason) return buildView(ctx);
    const cached = cachedRegistry(ctx);
    const stale = !cached || now() - cached.at >= ACCESS_REGISTRY_TTL_MS;
    // 动作进行中不另发 SSH：动作自己会重读，界面这时只是在等进度。
    if (!busy && (fresh || stale)) refreshRegistry(ctx);
    return buildView(ctx);
  }

  // ---- 释放一个闲置的登记端口 ----

  const inUseError = (port) => statusError(`端口 ${port} 是这台电脑在用的，不能单独释放；要释放它请用「撤销接入」`, 409, { code: "port-in-use" });

  // 发释放命令之前，对着磁盘上此刻的个人配置再看一遍（读登记那次 SSH 可能花了好几秒，期间配置可能变了；
  // 命令行向导、手改配置也不经过这个进程）：
  //   · 这个端口是个人配置此刻生效的那个 → 这台电脑在用，拒绝；
  //   · 它只是被另一处的端口盖住、没在生效的旧记录（命令行向导领过端口、后来在界面里「重新分配」就会留下
  //     这样一条）→ 先把这条清掉。登记放掉以后它不该再留在配置里：哪天盖着它的那一处没了，隧道就会建到
  //     已经被别人领走的端口上。生效的端口不受影响，隧道不动。
  // → 清了旧记录没有；在用 / 清不成抛错（登记都还没动）。
  async function settleLocalRecord(ctx, port) {
    if (simulation) return false;
    let personal;
    try {
      personal = getPersonalConfig() || {};
    } catch (error) {
      throw statusError(`个人配置读不出来（${error.message}），登记没有动`, 409, { code: "personal-config" });
    }
    if (effectivePersonalPort(personal, ctx.server.id) === port) throw inUseError(port);
    const patch = buildDropPortPatch(personal, ctx.server.id, { port });
    if (!patch) return false;
    try {
      await savePersonalConfig({ ...patch, expectedRevision: personal.revision ?? 0 });
    } catch (error) {
      throw statusError(`个人配置里还记着端口 ${port}，没能把这条旧记录清掉（${describeConfigError(error)}），登记没有动`, error?.status === 409 ? 409 : 500, { code: "stale-config" });
    }
    try {
      await refreshConfigIntoKernel();
    } catch (error) {
      log(`access: personal config saved but reload failed: ${error.message}`, { level: "warn" });
    }
    return true;
  }

  async function releasePort({ serverId = null, port } = {}) {
    const wanted = toPort(port);
    if (wanted === null) throw statusError("请指定要释放的端口", 400, { code: "form" });
    const ctx = await requireContext(serverId);
    assertFree();
    busy = { kind: "release", port: wanted };
    try {
      // 先重新读一遍：在用 / 正在被监听的判断必须是此刻的，不能拿一分钟前的缓存来定。
      const data = storeRegistry(ctx, await readRegistry(ctx));
      if (data.state === "unknown") {
        throw statusError(`读不到集群上的端口登记（${data.error?.message || "原因未知"}），没有做任何改动`, 502, { code: "survey-failed" });
      }
      if (data.state === "invalid") throw statusError("团队配置里的端口登记目录写得不对，没法释放登记", 409, { code: "no-registry" });
      if (data.state !== "ok") throw statusError("集群上没有可用的端口登记目录，没有可以释放的登记", 409, { code: "no-registry" });
      if (wanted === ctx.port) throw inUseError(wanted);
      const row = registryView(ctx, registry).ports.find((item) => item.port === wanted);
      if (!row) {
        const owner = registeredOwnerOf(data.survey, wanted);
        if (owner === null) throw statusError(`登记目录里没有端口 ${wanted} 的登记`, 409, { code: "absent" });
        throw statusError(`端口 ${wanted} 不在你名下${owner ? `（登记属主是 ${owner}）` : ""}，没有动它`, 409, { code: "not-owner" });
      }
      if (row.listening) {
        throw statusError(`端口 ${wanted} 正在被监听，可能是你另一台电脑的隧道在用；先停掉那条隧道再释放`, 409, { code: "port-listening" });
      }
      // 先清配置、再放登记：清不掉就停在这里，登记不动；清掉了登记却没放成，也只是少了一条没用的旧记录。
      const clearedStaleConfig = await settleLocalRecord(ctx, wanted);
      const res = await remote(ctx, buildReleaseCommand(data.dir, wanted), { timeoutMs: UNDO_SSH_WRITE_TIMEOUT_MS });
      const result = remoteOk(res) ? parseReleaseResult(res.stdout).status : "failed";
      if (result === "ok" || result === "absent") {
        // 登记已经不在了：从手里这份登记表里拿掉它，不必再读一遍。
        storeRegistry(ctx, { ...data, survey: { ...data.survey, entries: data.survey.entries.filter((item) => item.port !== wanted) } });
        log(`access: released registered port ${wanted} on ${ctx.server.id} (${result}${clearedStaleConfig ? "; stale record removed from personal config" : ""})`);
        busy = null;
        return { port: wanted, result, clearedStaleConfig, access: buildView(ctx) };
      }
      // 没有明确结论：登记可能删了也可能没删，下一次读必须重新问远端。
      generation += 1;
      registry = null;
      log(`access: releasing registered port ${wanted} on ${ctx.server.id} did not succeed (${result})`, { level: "warn" });
      if (result === "not-owner") throw statusError(`端口 ${wanted} 登记在别人名下，没有动它`, 409, { code: "not-owner" });
      const why = remoteOk(res) ? "服务器没有给出明确结论" : failureOf(res).message;
      throw statusError(`端口 ${wanted} 没有释放成功（${why}）。可以稍后再试`, 502, { code: "release-failed" });
    } finally {
      busy = null;
    }
  }

  // ---- 撤销：预览 ----

  // 「把这台服务器的端口从个人配置里拿掉」这一笔现在写不写得进去——与 savePersonalConfig 用同一批校验，
  // 只验不写。→ null（写得进去 / 没有可拿的）| 原因。
  function localDropBlocker(ctx) {
    if (simulation) return null;
    const personal = ctx.personal || {};
    const patch = buildDropPortPatch(personal, ctx.server.id);
    if (!patch) return null;
    const errors = [];
    if (patch.servers) {
      const teamServerIds = (ctx.config?.servers || []).filter((item) => item?.source !== "personal").map((item) => item.id);
      const checked = validatePersonalServersForWrite(patch.servers, {
        teamServerIds,
        previousServers: Array.isArray(personal.servers) ? personal.servers : [],
        previousPortOverrides: personal.portOverrides,
      });
      if (!checked.ok) errors.push(...checked.errors);
    }
    if (patch.portOverrides) {
      const checked = validatePortOverridesForWrite(patch.portOverrides, { previous: personal });
      if (!checked.ok) errors.push(...checked.errors);
    }
    return errors.length ? fieldErrorsText(errors) : null;
  }

  // 勾选「同时释放端口」会发生什么（随登记现状不同）。→ { port, available, owner, note } | null（没有端口）
  function releaseOption(ctx, data) {
    if (ctx.port == null) return null;
    const port = ctx.port;
    // 端口不是记在个人层的（写在团队 config.json 里）：这里拿不掉它，隧道会继续用——那就不能把登记放掉。
    if (!simulation && !previousPersonalRemotePorts(ctx.personal, ctx.server.id).includes(port)) {
      return { port, available: false, owner: "unknown", note: `端口 ${port} 写在团队配置里，不是这台电脑的个人配置领的，不能在这里释放。` };
    }
    if (data.state === "invalid") return { port, available: false, owner: "unknown", note: "团队配置里的端口登记目录写得不对，这里没法释放登记。" };
    // 登记放掉之后端口必须能从个人配置里拿掉；现在就写不进去的话（手改过的个人配置过不了保存时的校验），
    // 先不给释放——否则登记没了、隧道却还在这个端口上跑，再撤销一次也补不上。
    const blocker = localDropBlocker(ctx);
    if (blocker) return { port, available: false, owner: "unknown", note: `这台电脑的个人配置现在保存不了（${blocker}），端口拿不掉，所以不能在这里释放。先修好个人配置。` };
    const base = port === REVERSE_PORT_BASE;
    const option = (owner, note) => ({ port, available: true, owner, note: base ? `${note}${BASE_PORT_NOTE}` : note });
    if (data.state === "unknown") return option("unknown", `这次没读到端口登记（${data.error?.message || "原因未知"}）；勾选后照常尝试释放。`);
    const localOnly = "勾选后只从这台电脑的配置里拿掉它，隧道随之停止。";
    if (data.state !== "ok") return option("none", `集群上没有可用的端口登记目录，这个端口没有登记。${localOnly}`);
    const owner = registeredOwnerOf(data.survey, port);
    if (ownRegisteredPorts(data.survey).includes(port)) {
      return option("me", base ? "登记在你名下。释放后这台电脑上的隧道随之停止。" : "登记在你名下。释放后别人可以领走它，这台电脑上的隧道随之停止。");
    }
    if (owner !== null) return option("other", `登记在 ${owner || "别人"} 名下，不会动那份登记。${localOnly}`);
    return option("none", `登记目录里没有这个端口的登记。${localOnly}`);
  }

  // 确认框里的后果说明：不释放 / 同时释放各一段。
  function consequences(ctx) {
    // 只说代理设置：装好的命令行工具、登录凭证与公钥都不动（做完后的清单里逐条列出）。
    const keepBase = "撤销后，集群上新开的终端里代理设置回到接入之前的样子，codex / claude 在新终端里不再经这台电脑出网；已经在运行的不受影响。";
    if (ctx.port == null) return { keep: `${keepBase}之后重新走一遍接入引导即可恢复。`, release: null };
    return {
      keep: `${keepBase}端口 ${ctx.port} 的登记和这台电脑上的隧道保留，之后重新走一遍接入引导即可恢复。`,
      release: `撤销后这台电脑不再为集群上的 codex / claude 提供出网，已经在运行的会断网。端口 ${ctx.port} 从这台电脑的配置里拿掉，隧道随之停止；要再用，重新走接入引导领取端口。`,
    };
  }

  async function previewUndo({ serverId = null } = {}) {
    const ctx = await requireContext(serverId);
    assertFree();
    const holder = taskLock?.current(ctx.server.id);
    if (holder) throw statusError(busyMessage(holder), 409, { code: "busy", busy: holder });
    busy = { kind: "preview" };
    try {
      const unreadable = (failure) => statusError(`读不到集群上现在的配置（${failure.message}），没有做任何改动`, 502, { code: "survey-failed" });
      const surveyed = await remote(ctx, buildUndoSurveyCommand(), { timeoutMs: UNDO_SSH_READ_TIMEOUT_MS });
      const found = remoteOk(surveyed) ? parseUndoSurvey(surveyed.stdout) : null;
      if (!found) throw unreadable(failureOf(surveyed));

      const noProxyExtra = noProxyExtraFor(ctx.personal, ctx.server.id);
      const dry = await undoClusterSetup(ctx.server, { port: ctx.port, noProxyExtra, dryRun: true, ssh: sshFor(ctx) });
      const unread = dry.steps.find((step) => step.status === "failed");
      if (unread) throw unreadable(describeRemoteFailure(unread.error, { exitCode: unread.exitCode }));

      const data = ctx.port == null ? null : storeRegistry(ctx, await readRegistry(ctx));
      const release = data ? releaseOption(ctx, data) : null;
      const steps = planUndoSteps({ port: ctx.port, noProxyExtra }).map((step) => previewStep(step, found, dry.steps.find((item) => item.id === step.id)));
      const notes = [];
      if (ctx.port == null) notes.push(`这台电脑没有配置反向端口，~/${CLAUDE_SETTINGS_FILE} 里的代理设置无从比对，不会自动删除，请自行检查。`);
      const createdAt = now();
      preview = {
        id: newId(),
        serverId: ctx.server.id,
        port: ctx.port,
        createdAt,
        releaseAvailable: release?.available === true,
        releaseNote: release?.note || "",
        // 预览时读的是哪个登记目录：确认时要放的必须还是这一个。
        registryDir: data?.dir ?? null,
      };
      return {
        preview: {
          previewId: preview.id,
          serverId: ctx.server.id,
          host: ctx.server.host,
          port: ctx.port,
          steps,
          // 集群上没有任何要撤销的东西，也没有端口可放：没有可确认的。
          nothingToUndo: steps.every((step) => step.effect === "none") && ctx.port == null,
          release,
          consequences: consequences(ctx),
          notes,
          createdAt,
          expiresAt: createdAt + UNDO_PREVIEW_TTL_MS,
        },
        access: { ...buildView(ctx), busy: null },
      };
    } finally {
      busy = null;
    }
  }

  // ---- 撤销：执行 ----

  // 把这台服务器的端口从个人层拿掉（编排的 clearLocalPort）。→ 是否拿掉了；写不成抛错。
  async function dropLocalPort(ctx) {
    if (simulation) {
      simulation.sim.port = null;
      return true;
    }
    const personal = getPersonalConfig() || {};
    const patch = buildDropPortPatch(personal, ctx.server.id);
    if (!patch) return false;
    // 读与写之间没有 await，再带上版本号：别处刚改过个人配置就不覆盖，如实报没写成。
    try {
      await savePersonalConfig({ ...patch, expectedRevision: personal.revision ?? 0 });
    } catch (error) {
      // 编排只带走 message：把是哪个字段、为什么一起写进去。
      throw new Error(describeConfigError(error));
    }
    try {
      await refreshConfigIntoKernel();
    } catch (error) {
      // 端口已经从磁盘上拿掉（守护进程自己读盘），只是监控这边没立刻重载：下一轮配置巡检会跟上。
      log(`access: personal config saved but reload failed: ${error.message}`, { level: "warn" });
    }
    return true;
  }

  // 撤销之后仍留着的东西：沿用命令行那份清单，只把「隧道」一条换成与这次结果对得上的说法。
  function leftoversFor(ctx, { released }) {
    const { host } = ctx.server;
    return leftoverItems({ host, port: ctx.port }).map((item) => {
      if (item.id !== "tunnel" || ctx.port == null) return item.text;
      if (released) return `隧道会在几秒内自己停止。想确认端口已经不再监听：ssh ${host} 'ss -ltn | grep ${ctx.port}'（应无输出）`;
      return `端口 ${ctx.port} 的登记和这台电脑上的隧道都保留着，隧道仍在运行。不想再提供出网时，在首页停止所有连接，或再撤销一次并勾选释放端口`;
    });
  }

  function newJob(ctx, wantRelease) {
    const blank = { status: "pending", detail: "", manual: "" };
    const steps = planUndoSteps({ port: ctx.port, noProxyExtra: noProxyExtraFor(ctx.personal, ctx.server.id) }).map((step) => ({ id: step.id, title: stepTitle(step), ...blank }));
    if (wantRelease) {
      steps.push({ id: "release-port", title: releaseTitle(ctx.port), ...blank });
      steps.push({ id: "local-port", title: localPortTitle(ctx.port), ...blank });
    }
    return {
      id: newId(),
      serverId: ctx.server.id,
      host: ctx.server.host,
      port: ctx.port,
      releasePort: wantRelease,
      // "running" | "ok" | "failed"
      status: "running",
      // 每一步的 status: "pending" | "running" | "ok" | "skipped" | "failed" | "not-run"（前面有一步没做成，这一步没有执行）
      steps,
      summary: "",
      leftovers: [],
      startedAt: now(),
      finishedAt: null,
    };
  }

  function applyProgress(run, event) {
    const id = event.phase === "release" ? "release-port" : event.phase === "local-port" ? "local-port" : event.id;
    const step = run.steps.find((item) => item.id === id);
    if (step) Object.assign(step, stepOutcome(event));
  }

  function finishJob(ctx, run, result, thrown) {
    for (const step of run.steps) {
      // 编排自己抛了错（不该发生）：正在跑的那一步如实记成没成。
      if (step.status === "running") Object.assign(step, { status: "failed", detail: step.detail || `出错了：${thrown?.message || "原因未知"}` });
      else if (step.status === "pending") step.status = "not-run";
    }
    const ok = !thrown && result?.status === "ok";
    const released = ok && result.localPortCleared === true;
    run.status = ok ? "ok" : "failed";
    run.finishedAt = now();
    if (ok) {
      const base = "集群上的代理配置已撤销。";
      if (ctx.port == null) run.summary = base;
      else if (released) run.summary = `${base}端口 ${ctx.port} 已从这台电脑的配置里拿掉，隧道会在几秒内停止。`;
      else if (run.releasePort) run.summary = `${base}这台电脑的个人配置里没有找到端口 ${ctx.port}，本机配置没有改动。`;
      else run.summary = `${base}端口 ${ctx.port} 的登记和这台电脑上的隧道保留。`;
      run.leftovers = leftoversFor(ctx, { released });
    } else {
      const failed = run.steps.find((step) => step.status === "failed");
      const skipped = run.steps.some((step) => step.status === "not-run");
      run.summary = `${failed ? `停在「${failed.title}」这一步` : `撤销没有做完${thrown ? `（${thrown.message}）` : ""}`}${skipped ? "，后面的没有执行" : ""}。处理好原因后再撤销一次即可，已经做完的步骤不会重复改动。`;
    }
    // 登记可能变了：下一次读重新问远端。
    generation += 1;
    registry = null;
    if (simulation && ok) simulation.sim.undone = true;
    if (ok) {
      // "已接入"不再成立：清掉引导的进度；记成「稍后再说」，免得端口一释放它就自己弹出来。
      try {
        onboardingGuide?.reset?.();
        onboardingGuide?.setDismissed?.(true);
      } catch (error) {
        log(`access: could not reset onboarding guide after undo: ${error.message}`, { level: "warn" });
      }
    }
    const outcome = run.steps.map((step) => `${step.id}=${step.status}`).join(" ");
    // 没做成的原因也记进日志：进度只在内存里，控制面一重启就只剩这一行可查。
    const why = ok ? "" : `: ${run.steps.find((step) => step.status === "failed")?.detail || thrown?.message || "no reason recorded"}`;
    log(`access: undo on ${ctx.server.id} ${run.status} (release=${run.releasePort}; ${outcome})${why}`, ok ? undefined : { level: "warn" });
    // 假远端上什么都没变：fixture 模式不去惊动真的探针。
    if (!simulation) {
      try {
        onClusterChanged(ctx.server.id);
      } catch {}
    }
  }

  async function execute(ctx, run) {
    let result = null;
    let thrown = null;
    try {
      result = await undoClusterSetup(ctx.server, {
        port: ctx.port,
        noProxyExtra: noProxyExtraFor(ctx.personal, ctx.server.id),
        // 登记目录写错时不释放（releasePort 恒为 false，见 runUndo），这里不给目录、也不会用到它。
        // 要释放时，这个目录就是预览里读的那一个（runUndo 用同一份 ctx.config 核对过）。
        registryDir: resolveRegistryDir(ctx.config) || undefined,
        assumeYes: true,
        releasePort: run.releasePort,
        stopOnFailure: true,
        ssh: sshFor(ctx),
        clearLocalPort: () => dropLocalPort(ctx),
        onProgress: (event) => applyProgress(run, event),
      });
    } catch (error) {
      thrown = error;
    }
    try {
      finishJob(ctx, run, result, thrown);
    } catch (error) {
      // 收尾自己出了错：这次撤销不能永远停在「进行中」。
      run.status = "failed";
      run.finishedAt = now();
      run.summary = `撤销结束时出错了（${error.message}）。集群上做到哪一步见上面的列表，再撤销一次即可。`;
      log(`access: undo on ${ctx.server.id} could not be finalized: ${error.message}`, { level: "error" });
    }
  }

  // 确认后的撤销。立刻返回（undo.status = "running"），之后的进度看 getAccess。
  async function runUndo({ serverId = null, previewId, releasePort = false } = {}) {
    const ctx = await requireContext(serverId);
    assertFree();
    if (!preview || typeof previewId !== "string" || preview.id !== previewId || preview.serverId !== ctx.server.id) {
      throw statusError("请先预览会改什么，再确认撤销", 409, { code: "preview-required" });
    }
    if (now() - preview.createdAt > UNDO_PREVIEW_TTL_MS) throw statusError("预览是十分钟之前的了，请重新预览", 409, { code: "preview-expired" });
    if (preview.port !== ctx.port) throw statusError("这台电脑的端口配置在预览之后变了，请重新预览", 409, { code: "preview-stale" });
    const wantRelease = releasePort === true;
    if (wantRelease && ctx.port == null) throw statusError("这台电脑没有配置反向端口，没有可释放的", 400, { code: "form" });
    // 预览里已经说明了为什么不能放（登记目录写错了 / 端口写在团队配置里）：界面不会给勾选，这里再挡一道。
    if (wantRelease && !preview.releaseAvailable) throw statusError(preview.releaseNote || "这个端口不能在这里释放", 409, { code: "release-unavailable" });
    // 预览之后个人配置被改得保存不了了：同预览里的道理，不放。
    const blocker = wantRelease ? localDropBlocker(ctx) : null;
    if (blocker) throw statusError(`这台电脑的个人配置现在保存不了（${blocker}），端口拿不掉，所以不能释放。先修好个人配置`, 409, { code: "release-unavailable" });
    // 预览之后团队配置里的登记目录变了（含改坏了）：要放的已经不是预览里说的那份登记，绝不换个目录去放。
    if (wantRelease && (resolveRegistryDir(ctx.config) || null) !== preview.registryDir) {
      throw statusError("团队配置里的端口登记目录在预览之后变了，请重新预览", 409, { code: "preview-stale" });
    }
    // 与安装 / 回滚 / 登录互斥：它们也会改 env.sh 与 keys/。
    const unlock = taskLock ? taskLock.tryAcquire(ctx.server.id, { kind: "undo", now }) : () => {};
    if (!unlock) {
      const holder = taskLock.current(ctx.server.id);
      throw statusError(busyMessage(holder), 409, { code: "busy", busy: holder });
    }
    preview = null;
    busy = { kind: "undo" };
    job = newJob(ctx, wantRelease);
    log(`access: undo on ${ctx.server.id} started (port=${ctx.port ?? "none"}, release=${wantRelease})`);
    const run = job;
    currentRun = execute(ctx, run).finally(() => {
      unlock();
      busy = null;
    });
    return { access: buildView(ctx) };
  }

  return {
    getAccess,
    releasePort,
    previewUndo,
    runUndo,
    // 路由层用：有动作在做时说出是哪一个（接入引导的写接口据此回 409），没有则 null。
    busyNotice: () => (busy ? busyLabel(busy) : null),
    // 测试用：等当前这一次撤销与后台那一轮端口登记读取都结束。
    whenIdle: () => Promise.all([currentRun, registryInFlight]).then(() => {}),
  };
}
