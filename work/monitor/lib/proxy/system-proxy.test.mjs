import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemProxyDetector,
  parseHostPort,
  parseProxyEnv,
  parseScutilProxy,
  parseWindowsInternetSettings,
  WINDOWS_INTERNET_SETTINGS_KEY,
} from "./system-proxy.mjs";

// 2026-10-07 本机 `scutil --proxy` 原样输出（Clash Verge 开"系统代理"，混合端口 7897）。
const SCUTIL_CLASH = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}
`;

// 未开系统代理的 Mac（字段存在但 Enable=0；含分接口的 __SCOPED__ 嵌套字典，不能被当成顶层）。
const SCUTIL_OFF = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPPort : 8080
      HTTPProxy : 10.9.9.9
    }
  }
}
`;

const SCUTIL_PAC_SOCKS = `<dictionary> {
  HTTPEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:7890/pac
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
`;

// Windows `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` 的真实格式：
// 首行空行 + 键路径，值行"4 空格 名字 4 空格 类型 4 空格 数据"（名字可含空格），CRLF 换行，末尾列出子键。
const regOutput = (values) => [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    DisableCachingOfSSLPages    REG_DWORD    0x0",
  "    IE5_UA_Backup_Flag    REG_SZ    5.0",
  "    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)",
  "    ZonesSecurityUpgrade    REG_BINARY    E29F9C0E8D3BD701",
  "    MigrateProxy    REG_DWORD    0x1",
  ...values,
  "    ProxyOverride    REG_SZ    localhost;127.*;10.*;172.16.*;192.168.*;<local>",
  "    EnableHttp1_1    REG_DWORD    0x1",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\5.0",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\ZoneMap",
  "",
].join("\r\n");

test("parseScutilProxy：真实 Clash 样本取 HTTPS 代理当上游，SOCKS 一并报告；嵌套字典与数组不当顶层", () => {
  const parsed = parseScutilProxy(SCUTIL_CLASH);
  assert.deepEqual(parsed.proxy, { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897", scheme: "https" });
  assert.deepEqual(parsed.socks, { host: "127.0.0.1", port: 7897 });
  assert.equal(parsed.pac, null);

  assert.deepEqual(parseScutilProxy(SCUTIL_OFF), { proxy: null, socks: null, pac: null }, "__SCOPED__ 里的分接口代理不算系统代理");
  const pacSocks = parseScutilProxy(SCUTIL_PAC_SOCKS);
  assert.equal(pacSocks.proxy, null);
  assert.equal(pacSocks.pac, "http://127.0.0.1:7890/pac");
  assert.deepEqual(pacSocks.socks, { host: "127.0.0.1", port: 7891 });

  const httpOnly = parseScutilProxy("<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : proxy.corp.example\n}\n");
  assert.deepEqual(httpOnly.proxy, { host: "proxy.corp.example", port: 8080, url: "http://proxy.corp.example:8080", scheme: "http" });
  assert.deepEqual(parseScutilProxy(""), { proxy: null, socks: null, pac: null });
});

test("parseWindowsInternetSettings：单值写法 / 分协议写法（https 优先）/ ProxyEnable=0 / 只有 SOCKS / AutoConfigURL", () => {
  const single = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    127.0.0.1:7890"]));
  assert.deepEqual(single.proxy, { host: "127.0.0.1", port: 7890, url: "http://127.0.0.1:7890", scheme: "http" });
  assert.equal(single.pac, null);

  const perProto = parseWindowsInternetSettings(regOutput([
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=127.0.0.1:7890;socks=127.0.0.1:7892",
  ]));
  assert.deepEqual(perProto.proxy, { host: "127.0.0.1", port: 7891, url: "http://127.0.0.1:7891", scheme: "https" });
  assert.deepEqual(perProto.socks, { host: "127.0.0.1", port: 7892 });

  const httpOnlyProto = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    http=proxy.lan:3128"]));
  assert.deepEqual(httpOnlyProto.proxy, { host: "proxy.lan", port: 3128, url: "http://proxy.lan:3128", scheme: "http" });

  const disabled = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x0", "    ProxyServer    REG_SZ    127.0.0.1:7890"]));
  assert.deepEqual(disabled, { proxy: null, socks: null, pac: null }, "ProxyEnable=0 时 ProxyServer 不生效");

  const socksOnly = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    socks=127.0.0.1:7891"]));
  assert.equal(socksOnly.proxy, null);
  assert.deepEqual(socksOnly.socks, { host: "127.0.0.1", port: 7891 });

  const pac = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x0", "    AutoConfigURL    REG_SZ    http://127.0.0.1:7890/pac"]));
  assert.equal(pac.proxy, null);
  assert.equal(pac.pac, "http://127.0.0.1:7890/pac", "AutoConfigURL 不受 ProxyEnable 控制，单独报告");

  const schemeAndNoPort = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    http://proxy.lan"]));
  assert.deepEqual(schemeAndNoPort.proxy, { host: "proxy.lan", port: 80, url: "http://proxy.lan:80", scheme: "http" }, "不写端口按 80");

  const emptyValue = parseWindowsInternetSettings(regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    "]));
  assert.equal(emptyValue.proxy, null);
});

test("parseProxyEnv：小写优先、只认 http:// 当上游；socks 只报告；https:// 上游不支持", () => {
  assert.deepEqual(parseProxyEnv({ https_proxy: "http://127.0.0.1:7890", HTTPS_PROXY: "http://10.0.0.1:1" }).proxy, { host: "127.0.0.1", port: 7890, url: "http://127.0.0.1:7890", scheme: "https" });
  assert.deepEqual(parseProxyEnv({ HTTP_PROXY: "proxy.lan:3128" }).proxy, { host: "proxy.lan", port: 3128, url: "http://proxy.lan:3128", scheme: "http" });
  const socks = parseProxyEnv({ ALL_PROXY: "socks5://127.0.0.1:7891", https_proxy: "https://secure.example:443" });
  assert.equal(socks.proxy, null);
  assert.deepEqual(socks.socks, { host: "127.0.0.1", port: 7891 });
  assert.deepEqual(parseProxyEnv({}), { proxy: null, socks: null, pac: null });
});

test("parseHostPort：去 scheme 与结尾斜杠、IPv6 中括号、缺端口取默认，形态不对返回 null", () => {
  assert.deepEqual(parseHostPort("http://127.0.0.1:7890/"), { host: "127.0.0.1", port: 7890 });
  assert.deepEqual(parseHostPort("[::1]:7890"), { host: "::1", port: 7890 });
  assert.deepEqual(parseHostPort("proxy.lan", { defaultPort: 80 }), { host: "proxy.lan", port: 80 });
  for (const bad of ["", "proxy.lan", "a b:1", "u:p@h:1", "h:99999"]) assert.equal(parseHostPort(bad), null, bad);
});

test("createSystemProxyDetector：按平台取数（macOS scutil 绝对路径 / Windows reg.exe query / 其余读环境变量），30 秒缓存，force 重查，并发合并", async () => {
  let clock = 0;
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: SCUTIL_CLASH, error: null };
  };
  const mac = createSystemProxyDetector({ platform: "darwin", exec, now: () => clock });
  const [a, b] = await Promise.all([mac.detect(), mac.detect()]);
  assert.equal(a, b, "并发调用合并成一次取数");
  assert.deepEqual(calls, [["/usr/sbin/scutil", "--proxy"]]);
  assert.equal(a.source, "scutil");
  assert.equal(a.proxy.url, "http://127.0.0.1:7897");
  clock = 29_000;
  await mac.detect();
  assert.equal(calls.length, 1, "30 秒内复用");
  clock = 31_000;
  await mac.detect();
  assert.equal(calls.length, 2, "过期重查");
  await mac.detect({ force: true });
  assert.equal(calls.length, 3, "force 绕过缓存");

  const winCalls = [];
  const win = createSystemProxyDetector({
    platform: "win32",
    exec: async (file, args) => {
      winCalls.push([file, ...args]);
      return { stdout: regOutput(["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    127.0.0.1:7890"]), error: null };
    },
  });
  const w = await win.detect();
  assert.deepEqual(winCalls, [["reg.exe", "query", WINDOWS_INTERNET_SETTINGS_KEY]]);
  assert.equal(w.source, "registry");
  assert.equal(w.proxy.url, "http://127.0.0.1:7890");

  const linux = createSystemProxyDetector({ platform: "linux", env: { http_proxy: "http://10.1.1.1:3128" }, exec: async () => assert.fail("不该执行命令") });
  assert.equal((await linux.detect()).proxy.url, "http://10.1.1.1:3128");
});

test("createSystemProxyDetector：取数失败折算成没识别到（带 error），exec 抛错也不外抛", async () => {
  const failed = createSystemProxyDetector({ platform: "darwin", exec: async () => ({ stdout: "", error: "ENOENT" }) });
  const r = await failed.detect();
  assert.equal(r.proxy, null);
  assert.equal(r.error, "ENOENT");

  const throwing = createSystemProxyDetector({ platform: "win32", exec: async () => { throw new Error("spawn failed"); } });
  const t = await throwing.detect();
  assert.equal(t.proxy, null);
  assert.equal(t.source, "registry");
  assert.match(t.error, /spawn failed/);
});
