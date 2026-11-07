// Local Chrome + isolated fixture, including real onboarding HTTP steps and mocked CLI/egress only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withBench } from "./perf-ui/harness.mjs";

const tree = path.resolve(process.argv[2] || ".");
const out = path.resolve(process.argv[3] || "dist/onboarding-qa");
fs.mkdirSync(out, { recursive: true });
const report = { source: tree, checks: [], screenshots: [], errors: [] };
await withBench(tree, null, async ({ send, evaluate, waitFor, url, errors }) => {
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const original = window.fetch;
    window.__setupWrites = [];
    let job = null;
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/cli') return json({ eligible: true, serverId: 'server-01', serverName: '演示集群', busy: null, clis: {
        codex: { label: 'Codex', installed: true, version: '0.160.1', kind: 'standalone', login: 'none' },
        claude: { label: 'Claude Code', installed: false, version: null, kind: null, login: 'none', latest: '2.1.292' }
      }});
      if (url.pathname === '/api/cli/team-cache') return json({ serverId: 'server-01', dir: '/public/agent-hub/cli-cache', hub: true, isAdmin: true, sshUser: 'new-colleague',
        entries: { codex: [{ version: '0.160.1', size: 167772160 }], claude: [] }, best: { codex: '0.160.1', claude: null }, error: null });
      if (url.pathname === '/api/cli/codex/smoke-test') {
        window.__setupWrites.push({ path: url.pathname, body: JSON.parse(init.body) });
        return json({ cli: 'codex', ok: true, code: 'ok', message: '收到回复，Codex 可以正常使用', hint: '', reply: 'WORKBENCH-OK', tail: [], seconds: 6, envSh: true });
      }
      if (new RegExp('^/api/cli/(codex|claude)/login$').test(url.pathname)) {
        const body = JSON.parse(init.body); window.__setupWrites.push({ path: url.pathname, body });
        job = { jobId: 'fixture-login', cli: url.pathname.split('/')[3], serverId: body.serverId, method: body.method, state: 'running' };
        return json({ job });
      }
      if (url.pathname === '/api/cli/login/current') return json({ job: null });
      if (url.pathname === '/api/cli/login/jobs/fixture-login') return json({ job: { ...job, state: 'succeeded', message: '演示配置已保存', notes: ['网络可达，模型权限需首次对话确认'], warnings: [] } });
      if (url.pathname === '/api/egress/self-test') return json({ full: { serverId: 'server-01', ok: true, message: '集群经个人通道可达外网' }, results: [{ target: 'api.openai.com', ok: true }, { target: 'api.anthropic.com', ok: true }] });
      if (url.pathname === '/api/probe/cli%3Aserver-01/run') return json({ ok: true });
      return original(input, init);
    };
  })();` });
  await send("Page.navigate", { url });
  const ready = async expression => {
    if (await waitFor(expression) === null) throw new Error(`${expression}\n${await evaluate("document.getElementById('dlgOnboarding')?.innerText")}\n${JSON.stringify(errors)}`);
  };
  await ready("document.querySelector('#dlgOnboarding[open] [data-ob-form=start]')");
  await evaluate(`(() => { const form = document.querySelector('[data-ob-form=start]'); form.elements.sshUser.value = 'new-colleague'; form.elements.password.value = 'fixture-only-password'; form.requestSubmit(); })()`);
  await ready("document.querySelector('[data-ob-answer=hostkey-accept]')");
  await evaluate("document.querySelector('[data-ob-answer=hostkey-accept]').click()");
  await ready("!document.getElementById('onboardingNext').hidden && document.querySelector('#onboardingLogin [data-cli-method=relay]:not([disabled])')");
  report.checks.push("接入全过程完成后出现安装、官方登录、中转站与网络检查");
  await ready("document.getElementById('dlgOnboarding').dataset.obFocus === 'login login-codex'");
  assert.match(await evaluate("document.getElementById('onboardingHint').textContent"), /第 3 步/);
  assert.equal(await evaluate("document.getElementById('onboardingStage2').classList.contains('is-done') && document.getElementById('onboardingStage3').classList.contains('is-active')"), true);
  await ready("document.getElementById('onboardingCliBody').textContent.includes('团队缓存里有 Codex 0.160.1')");
  report.checks.push("下一步高亮落在 Codex 的登录按钮；第 2 段打勾、第 3 段进行中；团队缓存一行可见");
  assert.match(await evaluate("document.getElementById('onboardingRoute').textContent"), /127\.0\.0\.1:7892/);
  await evaluate("document.querySelector('#onboardingLogin [data-cli-login=codex][data-cli-method=relay]').click()");
  await ready("document.getElementById('dlgCliLogin').open && document.querySelector('[data-cl-method=relay][aria-checked=true]')");
  await evaluate(`(() => { document.getElementById('cliLoginBaseUrl').value = 'https://relay.example.com/v1'; document.getElementById('cliLoginKey').value = 'fixture-not-a-real-key'; document.getElementById('cliLoginForm').requestSubmit(); })()`);
  await ready("document.querySelector('#cliLoginPhase[data-state=succeeded]')");
  const write = await evaluate("window.__setupWrites[0]");
  assert.equal(write.body.serverId, "server-01"); assert.equal(write.body.method, "relay");
  assert.equal(await evaluate("document.getElementById('cliLoginKey').value"), "");
  await evaluate("document.getElementById('dlgCliLogin').close()");
  await ready("document.getElementById('onboardingLogin').textContent.includes('中转站配置已保存')");
  report.checks.push("中转配置锁定接入服务器、密钥框即时清空、完成后回到引导");
  await ready("document.getElementById('dlgOnboarding').dataset.obFocus === 'smoke smoke-codex'");
  const pulse = await evaluate("getComputedStyle(document.querySelector('[data-ob-smoke=codex]')).boxShadow");
  assert.notEqual(pulse, "none", "高亮按钮带描边");
  await send("Emulation.setDeviceMetricsOverride", { width: 1028, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("new Promise(r => setTimeout(r, 400))");
  {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(out, "focus-smoke.png"), Buffer.from(shot.data, "base64")); report.screenshots.push("focus-smoke.png");
  }
  await evaluate("document.querySelector('[data-ob-smoke=codex]').click()");
  await ready("document.getElementById('onboardingCheck').textContent.includes('收到回复，Codex 可以正常使用')");
  assert.deepEqual(await evaluate("window.__setupWrites.at(-1)"), { path: "/api/cli/codex/smoke-test", body: { serverId: "server-01" } });
  await ready("document.getElementById('dlgOnboarding').dataset.obFocus === 'finish'");
  report.checks.push("填好 Key 后高亮挪到测试对话；测试通过后高亮「进入工作台」");
  await evaluate("document.querySelector('[data-ob-check]').click()");
  await ready("document.getElementById('onboardingCheck').textContent.includes('集群经个人通道可达外网')");
  report.checks.push("检查网络和工具后仍明确区分网络可达与 Key/额度/模型权限");
  for (const [label, width, theme] of [["wide-dark", 1028, "dark"], ["narrow-light", 520, "light"]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.body.dataset.theme = ${JSON.stringify(theme)}`);
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const layout = await evaluate(`(() => { const d = document.getElementById('dlgOnboarding'), b = d.querySelector('.ob-body'); return { width: d.getBoundingClientRect().width, overflow: b.scrollWidth - b.clientWidth }; })()`);
    assert.ok(layout.width <= width && layout.overflow <= 1, JSON.stringify(layout));
    for (const position of ["top", "bottom"]) {
      await evaluate(`(() => { const b = document.querySelector('#dlgOnboarding .ob-body'); b.scrollTop = ${position === "top" ? "0" : "b.scrollHeight"}; })()`);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const filename = `${label}-${position}.png`;
      fs.writeFileSync(path.join(out, filename), Buffer.from(shot.data, "base64")); report.screenshots.push(filename);
    }
  }
  report.checks.push("520px / 1028px，深浅色引导无横向溢出");
  report.errors = errors;
  assert.deepEqual(errors, []);
}, { height: 900 });
fs.writeFileSync(path.join(out, "browser-verification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
