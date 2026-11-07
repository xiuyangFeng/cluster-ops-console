// 接入管理的跨模块接线（源码级）：行为由各模块自己的测试覆盖，这里只锁住几处"接错了测试也照样绿"的地方——
// 命令行脚本确实只是薄封装、界面的撤销占的是安装 / 登录共用的那把任务锁、远端写命令没有第二个出处、
// 界面只加在「接入引导」那一行下面。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("setup:undo 是薄封装：编排来自 lib/onboarding-guide/undo.mjs，脚本里不再自己拼撤销 / 释放命令", () => {
  const script = read("scripts/setup-undo.mjs");
  assert.match(script, /from "\.\.\/work\/monitor\/lib\/onboarding-guide\/undo\.mjs"/);
  assert.doesNotMatch(script, /buildUndoCommands|buildReleaseCommand|parseReleaseResult/, "命令的生成与结果解析都在 lib 里");
  assert.doesNotMatch(script, /cluster-env\.mjs|port-registry\.mjs/);
  // 运行时那一侧不反向依赖脚本目录（打包闭包守卫只看得到入口的静态闭包，这里直接点名这三个文件）
  for (const rel of ["undo.mjs", "undo-survey.mjs", "access.mjs"]) {
    assert.doesNotMatch(read(`work/monitor/lib/onboarding-guide/${rel}`), /from "[^"]*scripts\//, rel);
  }
});

test("远端写命令只有两个出处：撤销步骤经编排（buildUndoCommands），释放经 buildReleaseCommand；界面这一层自己只发读命令", () => {
  const access = read("work/monitor/lib/onboarding-guide/access.mjs");
  // access.mjs 里直接发给远端的命令（remote(ctx, <命令>, …) 的第二个参数）：只认得出这几个来源
  const direct = [...access.matchAll(/\bremote\(ctx, ([A-Za-z]+)/g)].map((match) => match[1]);
  assert.ok(direct.length >= 4, `发远端命令的调用点数量异常：${direct.join(", ")}`);
  assert.deepEqual([...new Set(direct)].sort(), ["buildRegistrySurveyCommand", "buildReleaseCommand", "buildUndoSurveyCommand", "command"]);
  // 那个裸的 command 只出现在交给编排的执行器里
  assert.match(access, /const sshFor = \(ctx\) => async \(_host, command, options = \{\}\) => \{\s*const res = await remote\(ctx, command, options\);/);
  assert.doesNotMatch(access, /wrapSh\(|sh -c|rm -f|\bsed\b/, "这一层不自己写 shell");
  const undo = read("work/monitor/lib/onboarding-guide/undo.mjs");
  assert.match(undo, /import \{ buildUndoCommands, CLAUDE_SETTINGS_FILE, CLUSTER_ENV_DIR \} from "\.\.\/cluster-env\.mjs";/);
  assert.match(undo, /import \{ buildReleaseCommand, parseReleaseResult \} from "\.\.\/port-registry\.mjs";/);
  assert.doesNotMatch(undo, /wrapSh\(|sh -c|rm -f/, "编排也不自己写 shell");
});

test("装配：接入管理拿到的是安装 / 登录共用的任务锁、现有的 savePersonalConfig 与 SSH 槽位；路由两组都接上", () => {
  const start = read("work/monitor/server/start.mjs");
  const block = start.match(/const accessManager = createAccessManager\(\{([\s\S]*?)\n {2}\}\);/);
  assert.ok(block, "start.mjs 里必须装配 accessManager");
  assert.match(block[1], /taskLock: toolkit\.cliTaskLock,/);
  assert.match(block[1], /savePersonalConfig: configManager\.savePersonalConfig,/);
  assert.match(block[1], /getPersonalConfig: configManager\.getPersonalConfig,/);
  assert.match(block[1], /acquireSshSlot: \(options\) => scheduler\.acquireSshSlot\(options\),/);
  assert.match(block[1], /buildPinnedProbeSshArgs\(server, config, \{ dataDir: paths\.dataRoot \}\)/);
  assert.match(block[1], /\n {4}fixtureMode,/);
  assert.match(block[1], /\n {4}onboardingGuide,/);
  // 撤销删了 keys/：结束后只重测 CLI 现状（ok: false = 不补跑 Agent 探针）
  assert.match(block[1], /onClusterChanged: \(serverId\) => \{\s*refreshAfterCliChange\(serverId, \{ ok: false \}\)\.catch\(\(\) => \{\}\);\s*\},/);
  assert.match(start, /\n {4}onboardingGuide,\n {4}accessManager,\n {2}\}\);/, "交给路由");
  // 登录服务用的是同一把锁
  assert.match(start, /taskLock: toolkit\.cliTaskLock,[\s\S]*taskLock: toolkit\.cliTaskLock,/);

  const router = read("work/monitor/lib/http-router.mjs");
  assert.match(router, /createOnboardingRoutes\(\{ onboardingGuide, accessManager \}\),\n\s*createOnboardingAccessRoutes\(\{ accessManager \}\),/);
});

test("界面只加在配置 →「接入引导」那一行下面：容器紧跟那一行、默认隐藏；打开配置时读；模块已登记预加载", () => {
  const html = read("work/monitor/public/index.html");
  const settings = html.slice(html.indexOf('<dialog id="dlgSettings"'), html.indexOf("</dialog>", html.indexOf('<dialog id="dlgSettings"')));
  const guideRow = settings.indexOf("data-onboarding-open");
  const container = settings.indexOf('<div class="settings-access" id="settingsAccess" hidden></div>');
  const offlineRow = settings.indexOf('data-dialog="dlgBootstrap"');
  assert.ok(guideRow > 0 && container > guideRow && offlineRow > container, "容器在「接入引导」与「离线安装 Agent」两行之间");
  assert.equal(settings.slice(guideRow, container).includes('class="settings-row"'), false, "中间没有隔着别的行");
  assert.equal(html.split('id="settingsAccess"').length, 2, "只有这一处");
  assert.match(html, /<link rel="modulepreload" href="\/assets\/js\/app\/settings-access\.js" \/>/);
  // 没有新面板、新浮层、新导航项
  assert.doesNotMatch(html, /dlgAccess|data-dialog="dlgUndo"|data-view="access"/);

  const app = read("work/monitor/public/app.js");
  assert.match(app, /const settingsAccess = createSettingsAccess\(\{ doc, getJson, postJson, showToast, copyText, refresh \}\);/);
  assert.match(app, /dialogs\.onDialogOpen\("dlgSettings", settingsAccess\.onOpen\);/);

  // 插在两行之间的那一块：后一行的分隔线要补上（相邻兄弟选择器隔着它不再命中）
  assert.match(read("work/monitor/public/assets/css/settings.css"), /\.settings-access \+ \.settings-row \{ border-top: 1px solid var\(--hud-border\); \}/);
});

// ---- 经真实的 HTTP 门面走一遍（鉴权 + 路由分派）----

function makeRes() {
  return {
    status: null,
    json: null,
    setHeader() {},
    writeHead(status) {
      this.status = status;
    },
    end(value) {
      try {
        this.json = JSON.parse(String(value ?? ""));
      } catch {
        this.json = null;
      }
    },
  };
}

async function makeRouter(overrides = {}) {
  const { createHttpRouter } = await import("../work/monitor/lib/http-router.mjs");
  return createHttpRouter({
    authToken: "fixture",
    publicDir: "/nonexistent",
    logsDir: "/nonexistent",
    maxSseConnections: 8,
    sseHeartbeatMs: 25000,
    store: {},
    scheduler: {},
    metricsStore: {},
    bootstrapRunner: {},
    toolkit: {},
    appendLog() {},
    operationStorage: { run: (_context, fn) => fn() },
    getConfig: async () => ({}),
    ...overrides,
  });
}

async function send(router, method, url, { body, token = "fixture" } = {}) {
  const req = {
    url,
    method,
    headers: { host: "127.0.0.1:8877", ...(token ? { "x-auth-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    [Symbol.asyncIterator]: async function* iterator() {
      if (body) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = makeRes();
  await router.handleHttpRequest(req, res);
  return res;
}

test("/api/onboarding/access* 经 HTTP 门面：四个接口各到各的服务方法；写接口没带令牌 401；与接入引导的路由互不截胡", async () => {
  const hits = [];
  const accessManager = {
    getAccess: async (options) => { hits.push(["access.get", options.fresh]); return { available: true }; },
    releasePort: async (args) => { hits.push(["access.release", args.port]); return { result: "ok" }; },
    previewUndo: async () => { hits.push(["access.preview"]); return { preview: { previewId: "p1" } }; },
    runUndo: async (args) => { hits.push(["access.run", args.previewId, args.releasePort]); return { access: {} }; },
    busyNotice: () => null,
  };
  const onboardingGuide = {
    getState: () => { hits.push(["guide.get"]); return { phase: "idle" }; },
    start: () => { hits.push(["guide.start"]); return { phase: "running" }; },
  };
  const router = await makeRouter({ accessManager, onboardingGuide });
  assert.equal((await send(router, "GET", "/api/onboarding")).status, 200);
  assert.equal((await send(router, "GET", "/api/onboarding/access?fresh=1")).status, 200);
  assert.equal((await send(router, "POST", "/api/onboarding/access/release-port", { body: { port: 7895 } })).status, 200);
  assert.equal((await send(router, "POST", "/api/onboarding/access/undo/preview", { body: {} })).status, 200);
  assert.equal((await send(router, "POST", "/api/onboarding/access/undo/run", { body: { previewId: "p1", releasePort: true } })).status, 200);
  assert.equal((await send(router, "POST", "/api/onboarding/start", { body: { sshUser: "amy" } })).status, 200);
  assert.deepEqual(hits, [["guide.get"], ["access.get", true], ["access.release", 7895], ["access.preview"], ["access.run", "p1", true], ["guide.start"]]);

  // 会删东西的写接口：没带令牌一律进不来，服务方法不被调用
  const before = hits.length;
  for (const path of ["/api/onboarding/access/release-port", "/api/onboarding/access/undo/preview", "/api/onboarding/access/undo/run"]) {
    assert.equal((await send(router, "POST", path, { body: { port: 7895, previewId: "p1" }, token: "" })).status, 401, path);
    assert.equal((await send(router, "POST", path, { body: { port: 7895, previewId: "p1" }, token: "wrong" })).status, 401, path);
  }
  assert.equal(hits.length, before);
  // 没有这样的路径 / 方法：落到 404，不被别的组接走
  assert.equal((await send(router, "POST", "/api/onboarding/access/undo", { body: {} })).status, 404);
  assert.equal((await send(router, "GET", "/api/onboarding/access/undo/run")).status, 404);
});

test("/api/onboarding/access* 经 HTTP 门面：服务没装配时 503，不影响别的路由", async () => {
  const router = await makeRouter({ onboardingGuide: { getState: () => ({ phase: "idle" }) } });
  assert.equal((await send(router, "GET", "/api/onboarding/access")).status, 503);
  assert.equal((await send(router, "POST", "/api/onboarding/access/undo/run", { body: { previewId: "p1" } })).status, 503);
  assert.equal((await send(router, "GET", "/api/onboarding")).status, 200);
});
