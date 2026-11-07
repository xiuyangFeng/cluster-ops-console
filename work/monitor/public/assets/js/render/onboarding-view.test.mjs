import assert from "node:assert/strict";
import test from "node:test";

import { answerBody, buildGuideHtml, guideSubtitle, shouldAutoOpenGuide } from "./onboarding-view.js";

const STEP_TITLES = ["连接服务器并核对指纹", "准备本机密钥", "把公钥装到服务器", "保存连接配置", "领取专属端口", "建立隧道", "出网自测", "写集群侧配置"];
const STEP_IDS = ["hostkey", "key", "authorize", "identity", "port", "tunnel", "egress", "clusterEnv"];
const steps = (statuses = {}, details = {}) => STEP_IDS.map((id, i) => ({ id, title: STEP_TITLES[i], status: statuses[id] || "pending", detail: details[id] || "", error: null }));
const guide = (patch = {}) => ({
  available: true, phase: "idle", busy: false, dismissed: false, platform: "darwin",
  server: { id: "server-01", name: "主集群", alias: "myserver" },
  form: { sshUser: "", hostName: "10.0.0.8", hostNameLocked: true, sshPort: 22 },
  steps: steps(), prompt: null, result: { sshUser: "", remotePort: null, registered: null, warnings: [] },
  ...patch,
});

test("shouldAutoOpenGuide：没配置好或上次走到一半才自动弹；点过稍后 / 已走完 / 老用户都不弹", () => {
  const idle = { phase: "idle", dismissed: false, busy: false };
  assert.equal(shouldAutoOpenGuide({ onboarding: "needs-setup", onboardingGuide: idle }), true);
  assert.equal(shouldAutoOpenGuide({ onboarding: "partial", onboardingGuide: idle }), true);
  assert.equal(shouldAutoOpenGuide({ onboarding: "ready", onboardingGuide: idle }), false, "已经配好的人不打扰");
  assert.equal(shouldAutoOpenGuide({ onboarding: "no-servers", onboardingGuide: idle }), false);
  assert.equal(shouldAutoOpenGuide({ onboarding: "needs-setup", onboardingGuide: { ...idle, dismissed: true } }), false);
  for (const phase of ["running", "waiting", "failed", "paused"]) {
    assert.equal(shouldAutoOpenGuide({ onboarding: "ready", onboardingGuide: { ...idle, phase } }), true, phase);
  }
  assert.equal(shouldAutoOpenGuide({ onboarding: "needs-setup", onboardingGuide: { ...idle, phase: "done" } }), false);
  assert.equal(shouldAutoOpenGuide({ onboarding: "needs-setup" }), false, "旧后端没有引导");
  assert.equal(shouldAutoOpenGuide(null), false);
});

test("表单：地址预烤时只问用户名和密码；没预烤才出现地址与端口；密码框从不回填", () => {
  const baked = buildGuideHtml(guide({ form: { sshUser: "amy", hostName: "10.0.0.8", hostNameLocked: true, sshPort: 22 } }));
  assert.match(baked, /data-ob-form="start"/);
  assert.match(baked, /name="sshUser" value="amy"/);
  assert.match(baked, /name="password" type="password" autocomplete="off"/);
  assert.doesNotMatch(baked, /name="hostName"/);
  assert.match(baked, /密码只用一次/);

  const open = buildGuideHtml(guide({ form: { sshUser: "", hostName: "", hostNameLocked: false, sshPort: 22 } }));
  assert.match(open, /name="hostName"/);
  assert.match(open, /name="sshPort" type="number"/);

  // 校验没过重画：保留刚填的用户名，标出错的那一项，给出原因
  const errored = buildGuideHtml(guide(), { formError: { field: "sshUser", message: "请填写集群用户名" }, draft: { sshUser: "a b" } });
  assert.match(errored, /name="sshUser" value="a b"[^>]*aria-invalid="true"/);
  assert.match(errored, /role="alert">请填写集群用户名</);
  assert.match(buildGuideHtml(guide(), { submitting: true }), /disabled>正在开始…</);
});

test("步骤清单：每步带状态类与说明；提问嵌在发问的那一步下面", () => {
  const html = buildGuideHtml(guide({
    phase: "waiting",
    steps: steps({ hostkey: "waiting" }),
    prompt: { step: "hostkey", kind: "hostkey", host: "10.0.0.8", port: 22, linesHash: "abc", fingerprints: [{ type: "ssh-ed25519", sha256: "SHA256:AAAA" }] },
  }));
  assert.equal((html.match(/class="ob-step /g) || []).length, 8);
  assert.match(html, /ob-step is-waiting[\s\S]*连接服务器并核对指纹[\s\S]*<span>ED25519<\/span><code>SHA256:AAAA<\/code>/);
  assert.match(html, /data-ob-answer="hostkey-accept"/);
  assert.match(html, /data-ob-answer="hostkey-decline"/);
  assert.match(html, /ob-step is-pending[\s\S]*准备本机密钥/);
});

test("密码提问：首次只问密码；输错说明次数；通道不通时只留终端方式并展开", () => {
  const ask = (prompt) => buildGuideHtml(guide({ phase: "waiting", steps: steps({ hostkey: "done", key: "done", authorize: "waiting" }), prompt: { step: "authorize", kind: "password", user: "amy", host: "10.0.0.8", attempts: 0, error: null, manualCommand: 'cat "k.pub" | ssh amy@10.0.0.8 "…"', ...prompt } }));
  const first = ask({});
  assert.match(first, /data-ob-form="password"/);
  assert.match(first, /amy 的集群密码/);
  assert.match(first, /<details class="ob-manual">/);
  assert.doesNotMatch(first, /role="alert"/);

  const wrong = ask({ error: "wrong-password", attempts: 2 });
  assert.match(wrong, /密码不对，请重新输入。已经连续输错 2 次/);
  assert.doesNotMatch(ask({ error: "wrong-password", attempts: 1 }), /连续输错/);

  const channel = ask({ error: "channel" });
  assert.match(channel, /<details class="ob-manual" open>/);
  assert.doesNotMatch(channel, /name="password"/, "页面里的密码框此时没用");
  assert.match(channel, /cat &quot;k\.pub&quot; \| ssh amy@10\.0\.0\.8/);
  assert.match(channel, /data-ob-answer="password-manual"/);
  assert.match(ask({ error: "still-missing" }), /还没检测到公钥/);
});

test("其余提问：Host 段对比、出网、旧代理导出", () => {
  const withPrompt = (stepId, prompt) => buildGuideHtml(guide({ phase: "waiting", steps: steps({ [stepId]: "waiting" }), prompt: { step: stepId, ...prompt } }));
  const ssh = withPrompt("identity", { kind: "ssh-config", alias: "myserver", existing: "Host myserver\n  User old", proposed: "Host myserver\n  User amy" });
  assert.match(ssh, /现在的[\s\S]*User old[\s\S]*要写成[\s\S]*User amy/);
  assert.match(ssh, /data-ob-answer="ssh-overwrite"[\s\S]*data-ob-answer="ssh-keep"/);

  const egress = withPrompt("egress", { kind: "egress", text: "直连不通，建议改为系统代理。", failures: [{ target: "api.openai.com", message: "TLS 握手超时" }] });
  assert.match(egress, /直连不通，建议改为系统代理。/);
  assert.match(egress, /<li>api\.openai\.com：TLS 握手超时<\/li>/);
  assert.match(egress, /data-ob-answer="egress-system"[\s\S]*data-ob-answer="egress-skip"/);

  const strays = withPrompt("clusterEnv", { kind: "strays", items: [{ file: ".bashrc", line: 145, text: "export https_proxy=socks5h://127.0.0.1:1080" }] });
  assert.match(strays, /有 1 行旧的代理设置/);
  assert.match(strays, /~\/\.bashrc:145<\/span><code>export https_proxy=socks5h/);
  assert.match(strays, /data-ob-answer="strays-comment"[\s\S]*data-ob-answer="strays-keep"/);
});

test("失败：原因 + 下一步 + 原始信息 + 手动内容；执行中按钮按住；暂停时给「继续」", () => {
  const failedSteps = steps({ hostkey: "failed" });
  failedSteps[0].error = { code: "unreachable", message: "连不上 10.0.0.8:22", hint: "连上校园网后点「重试」。", detail: "ssh: connect timed out", manual: "mkdir -p ~/.config" };
  const html = buildGuideHtml(guide({ phase: "failed", steps: failedSteps }));
  assert.match(html, /ob-step is-failed/);
  assert.match(html, /ob-fail-msg">连不上 10\.0\.0\.8:22</);
  assert.match(html, /连上校园网后点「重试」。/);
  assert.match(html, /ssh: connect timed out/);
  assert.match(html, /手动执行的内容[\s\S]*mkdir -p ~\/\.config/);
  assert.match(html, /data-ob-retry>重试</);
  assert.match(html, /data-ob-restart>重新填写账号</);
  assert.match(buildGuideHtml(guide({ phase: "failed", busy: true, steps: failedSteps })), /data-ob-retry disabled>重试</);

  const paused = buildGuideHtml(guide({ phase: "paused", steps: steps({ hostkey: "done" }) }));
  assert.match(paused, /上次进行到一半就关掉了/);
  assert.match(paused, /data-ob-retry>继续</);
});

test("完成页：账号与端口摘要、未登记提醒带管理员命令；有提醒的步骤展开并可单独重测", () => {
  const all = Object.fromEntries(STEP_IDS.map((id) => [id, "done"]));
  const clean = buildGuideHtml(guide({ phase: "done", form: { sshUser: "amy", hostName: "10.0.0.8", hostNameLocked: true, sshPort: 22 }, steps: steps(all), result: { sshUser: "amy", remotePort: 7892, registered: true, warnings: [] } }));
  assert.match(clean, /已接入/);
  assert.match(clean, /amy@myserver · 专属端口 7892/);
  assert.match(clean, /<details class="ob-fold">/);
  assert.doesNotMatch(clean, /ob-warnings/);
  assert.match(clean, /data-ob-restart>重新接入</, "走完之后仍有重新接入的出口（换账号 / 认证失败时从横幅进来）");

  const flagged = buildGuideHtml(guide({
    phase: "done", steps: steps({ ...all, egress: "warn" }, { egress: "直连不通" }),
    result: { sshUser: "amy", remotePort: 7892, registered: false, warnings: [{ code: "port-unregistered", text: "这个端口没有登记", command: "sudo install -d -m 1777 /public/agent-hub/ports" }] },
  }));
  assert.match(flagged, /ob-warnings[\s\S]*这个端口没有登记[\s\S]*install -d -m 1777/);
  assert.match(flagged, /<details class="ob-fold" open>[\s\S]*1 项需要留意/);
  assert.match(flagged, /data-ob-retry-step="egress">重新测试</);
});

test("不可用 / 读取中；所有来自服务器的文字都转义", () => {
  assert.match(buildGuideHtml(null), /正在读取/);
  assert.match(buildGuideHtml(guide({ available: false })), /没有可以接入的集群服务器/);
  const evil = '<img src=x onerror="alert(1)">';
  const failedSteps = steps({ hostkey: "failed" }, { hostkey: evil });
  failedSteps[0].error = { message: evil, hint: evil, detail: evil, manual: evil };
  const html = buildGuideHtml(guide({ phase: "failed", steps: failedSteps }));
  assert.ok(!html.includes("<img"));
  const prompted = buildGuideHtml(guide({ phase: "waiting", steps: steps({ authorize: "waiting" }), prompt: { step: "authorize", kind: "password", user: evil, manualCommand: evil } }));
  assert.ok(!prompted.includes("<img"));
});

test("guideSubtitle / answerBody", () => {
  assert.equal(guideSubtitle(guide()), "主集群 · 10.0.0.8");
  assert.equal(guideSubtitle(guide({ phase: "running", form: { sshUser: "amy", hostName: "10.0.0.8" } })), "主集群 · amy@10.0.0.8");
  assert.equal(guideSubtitle(guide({ server: null })), "");
  const state = guide({ prompt: { kind: "hostkey", linesHash: "abc" } });
  assert.deepEqual(answerBody("hostkey-accept", state), { kind: "hostkey", accept: true, linesHash: "abc" });
  assert.deepEqual(answerBody("hostkey-decline", state), { kind: "hostkey", accept: false });
  assert.deepEqual(answerBody("password-manual", state), { kind: "password", manualDone: true });
  assert.deepEqual(answerBody("ssh-overwrite", state), { kind: "ssh-config", action: "overwrite" });
  assert.deepEqual(answerBody("egress-system", state), { kind: "egress", action: "use-system" });
  assert.deepEqual(answerBody("strays-keep", state), { kind: "strays", action: "keep" });
  assert.equal(answerBody("nope", state), null);
});

test("Windows 上没有 ssh：失败处给「安装 OpenSSH 客户端」；安装中只出进度；没装上写原因；其它失败与其它系统不出", () => {
  const failedSteps = steps({ hostkey: "failed" });
  failedSteps[0].error = { code: "ssh-missing", message: "这台电脑上没有 ssh 命令", hint: "点下面的「安装 OpenSSH 客户端」", detail: "", manual: "" };
  const idle = buildGuideHtml(guide({ phase: "failed", steps: failedSteps, openSsh: { installing: false, error: null } }));
  assert.match(idle, /data-ob-install-openssh>安装 OpenSSH 客户端</);
  assert.match(idle, /btn btn-secondary" data-ob-retry>重试</, "主按钮让给一键安装");
  const installing = buildGuideHtml(guide({ phase: "failed", busy: true, steps: failedSteps, openSsh: { installing: true, error: null } }));
  assert.match(installing, /正在安装 OpenSSH 客户端/);
  assert.doesNotMatch(installing, /data-ob-install-openssh/);
  const refused = buildGuideHtml(guide({ phase: "failed", steps: failedSteps, openSsh: { installing: false, error: "没有获得管理员确认 <b>" } }));
  assert.match(refused, /ob-error" role="alert">没有获得管理员确认 &lt;b&gt;</);
  assert.doesNotMatch(buildGuideHtml(guide({ phase: "failed", steps: failedSteps, openSsh: null })), /data-ob-install-openssh/, "非 Windows");
  const other = steps({ hostkey: "failed" });
  other[0].error = { code: "unreachable", message: "连不上", hint: "", detail: "", manual: "" };
  assert.doesNotMatch(buildGuideHtml(guide({ phase: "failed", steps: other, openSsh: { installing: false, error: null } })), /data-ob-install-openssh/);
});
