import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnFixtureMonitor } from "./fixture-monitor.mjs";

// 新电脑验收：独立配置和运行目录，不发真实 SSH、不读写用户的接入进度。
export async function runOnboardingDeviceBrowserSmoke({ BrowserWindow, rootDir, waitFor, screenshotDir }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cwb-onboarding-browser-"));
  if (!path.resolve(dataDir).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Unexpected fixture directory");
  const configPath = path.join(dataDir, "config.json"), localConfigPath = path.join(dataDir, "config.local.json");
  await writeFile(configPath, JSON.stringify({ activeServerId: "server-01", agents: [{ id: "codex", kind: "codex" }],
    servers: [{ id: "server-01", name: "新电脑接入验收", host: "cluster-fixture", sshPort: 22, tunnel: false }] }));
  await writeFile(localConfigPath, "{}");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const token = "onboarding-device-fixture-token", baseUrl = `http://127.0.0.1:${port}`;
  const monitor = spawnFixtureMonitor({ command: process.execPath, script: path.join(rootDir, "work/monitor/monitor-server.mjs"),
    cwd: rootDir, port, authToken: token, dataDir, configPath, localConfigPath });
  let win;
  try {
    await waitFor(async () => { try { return (await fetch(`${baseUrl}/api/session`)).ok; } catch { return false; } }, () => `onboarding fixture failed: ${monitor.output()}`);
    win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const page = (js) => win.webContents.executeJavaScript(js);
    await win.loadURL(baseUrl);
    await waitFor(() => page('document.getElementById("dlgOnboarding").open && Boolean(document.querySelector("[data-ob-form=start]"))'), "new computer did not open onboarding");
    assert.match(await page('document.getElementById("onboardingMain").textContent'), /本机尚无专用密钥/);
    assert.equal(await page('document.querySelector("[data-ob-form=start] [name=mode]").value'), "monitor");
    assert.equal(await page(`(() => {
      const form = document.querySelector('[data-ob-form=start]');
      form.elements.hostName.value = 'cluster.fixture.invalid'; form.elements.sshUser.value = 'newstudent';
      form.elements.password.value = 'wrong'; document.getElementById('onboardingStart').click();
      return form.elements.password.value;
    })()`), "");
    await waitFor(() => page('Boolean(document.querySelector("[data-ob-answer=hostkey-accept]"))'), "fingerprint confirmation missing");
    assert.match(await page('document.getElementById("onboardingHint").textContent'), /核对.*指纹/);
    await page('document.querySelector("[data-ob-answer=hostkey-accept]").click()');
    await waitFor(() => page('Boolean(document.querySelector("[data-ob-form=password] .ob-error"))'), "wrong password did not show recovery prompt");
    assert.match(await page('document.querySelector("[data-ob-form=password] .ob-error").textContent'), /密码不对/);
    assert.equal(await page(`(() => { const form = document.querySelector('[data-ob-form=password]'); form.elements.password.value = 'correct'; form.requestSubmit(); return form.elements.password.value; })()`), "");
    await waitFor(() => page('!document.getElementById("onboardingFooter").hidden'), "quick onboarding did not finish");
    assert.equal(await page('document.getElementById("onboardingNext").hidden'), true, "resource access should not require CLI/API setup");
    const response = await fetch(`${baseUrl}/api/onboarding`, { headers: { "x-auth-token": token } });
    const guide = await response.json();
    assert.equal(guide.phase, "done");
    assert.deepEqual(guide.steps.filter((s) => s.status === "skipped").map((s) => s.id), ["port", "tunnel", "egress", "clusterEnv"]);
    if (screenshotDir) await writeFile(path.join(screenshotDir, "onboarding-quick-complete.png"), (await win.webContents.capturePage()).toPNG());
    // 换电脑入口可明确重检，不停在旧的完成页。
    await page('document.getElementById("dlgOnboarding").close()');
    await waitFor(() => page('!document.getElementById("dlgOnboarding").open'), "completed guide did not close");
    await page('document.getElementById("dlgSettings").showModal()');
    await waitFor(() => page('document.getElementById("dlgSettings").open'), "settings did not open");
    await page('document.querySelector("[data-onboarding-recheck]").click()');
    await waitFor(() => page('Boolean(document.querySelector("[data-ob-form=start]")) && document.getElementById("dlgOnboarding").open'),
      async () => `new-computer entry did not reset: ${await page('JSON.stringify({open:document.getElementById("dlgOnboarding").open,body:document.getElementById("onboardingMain").textContent.slice(0,500)})')}`);
    win.setSize(520, 820);
    await waitFor(() => page("window.innerWidth <= 520"), "narrow onboarding window did not resize");
    assert.ok(await page('document.getElementById("dlgOnboarding").scrollWidth <= document.getElementById("dlgOnboarding").clientWidth + 2'), "onboarding overflows at 520px");
    assert.ok(await page('(() => { const r = document.getElementById("onboardingStart").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()'), "start action should remain visible on a narrow screen");
    if (screenshotDir) await writeFile(path.join(screenshotDir, "onboarding-new-computer.png"), (await win.webContents.capturePage()).toPNG());
    console.log("browser-smoke: fresh computer, fingerprint, password retry, quick resource access, recheck entry and narrow layout ok");
  } finally {
    win?.destroy();
    await monitor.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}
