import assert from "node:assert/strict";
import test from "node:test";
import { createProcessProbe } from "./processes.mjs";

const config = { servers: [{ id: "s1", host: "cluster.example", remotePort: 7895, localPort: 8888 }] };
const rows = [
  { ProcessId: 41, CommandLine: '"C:\\应用 程序\\Codex Operations Console.exe" work\\monitor\\channel-supervisor.mjs' },
  { ProcessId: 42, CommandLine: '"C:\\应用 程序\\Codex Operations Console.exe" work\\local_http_connect_proxy.mjs' },
  { ProcessId: 43, CommandLine: '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -R 127.0.0.1:7895:127.0.0.1:8888 cluster.example' },
];

test("Windows 进程探针从 CIM 识别安装版 supervisor、代理与 SSH；分钟巡检后仍不丢失", async () => {
  let time = 0;
  const probe = createProcessProbe({ getConfig: async () => config, getMainServerConfig: () => config.servers[0], platform: "win32", now: () => time,
    execFileCmd: async (cmd) => { assert.match(cmd, /\\powershell\.exe$/i); return { code: 0, stdout: JSON.stringify(rows) }; },
  });
  for (const t of [0, 5000, 60000, 120000]) {
    time = t;
    const r = await probe.runProcessesProbe();
    assert.equal(r.level, "ok");
    assert.deepEqual([r.data.processes.supervisor[0].pid, r.data.processes.localProxy[0].pid, r.data.processes.reverseTunnel[0].pid], ["41", "42", "43"]);
  }
});

test("Windows 进程清单未含代理但 HTTP 探活有身份 PID 时不误报停止；CIM 故障不当成进程全死", async () => {
  let failed = false;
  let healthy = true;
  const probe = createProcessProbe({ getConfig: async () => config, getMainServerConfig: () => config.servers[0], platform: "win32", now: () => 0,
    execFileCmd: async () => ({ code: failed ? 1 : 0, stdout: JSON.stringify(rows.filter((p) => p.ProcessId !== 42)) }),
    readProxyHealth: async (port) => { assert.equal(port, 8888); return { ok: healthy, proxy: { pid: 42 } }; },
  });
  assert.equal((await probe.runProcessesProbe()).level, "ok");
  healthy = false;
  assert.equal((await probe.getProcesses()).localProxy.length, 0, "相同 CIM 清单仍需重测 HTTP，不保留旧健康结果");
  failed = true;
  await assert.rejects(() => probe.getProcesses(), /Windows 进程命令行暂时无法读取/);
  const unknown = await probe.runProcessesProbe();
  assert.equal(unknown.level, "waiting");
  assert.equal(unknown.data.processQueryIndeterminate, true);
});
