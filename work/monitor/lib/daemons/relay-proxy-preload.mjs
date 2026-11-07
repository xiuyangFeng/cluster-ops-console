// relay-proxy-preload.mjs —— 集群上 Paseo 守护进程的「中继走代理」预加载脚本（CommonJS 源码字符串）。
//
// 背景：集群直连外网的 TLS 被校园网设备拦截（1024 位自签证书，Node 报 "EE certificate key too weak"），
// Paseo 守护进程连不上官方中继 relay.paseo.sh，扫码 / app.paseo.sh 配对就进不了集群。
// 而 Paseo 用的 ws 库自带 createConnection，Node 的 HTTPS_PROXY / NODE_USE_ENV_PROXY 对它不生效，
// 所以改用 NODE_OPTIONS=--require 预加载：只把 host 命中 *.paseo.sh 的 tls.connect 套上一层
// HTTP CONNECT 隧道（本账号自己的反向隧道 127.0.0.1:<端口>），其余连接原样放行。
// 端口由启动脚本经 PASEO_RELAY_PROXY_PORT 传入（v2.56：每人端口不同，绝不默认 7891——那是别人的隧道）；
// 没传或不合法时不套隧道，守护进程照常直连（中继可能连不上，但不会走到别人的出网）。
//
// 代理口令（v2.62）：本机代理开了口令时 CONNECT 要带 Proxy-Authorization。口令不经环境变量传给守护进程
// （它是常驻的，换口令之后手里的就过期了），也不写进这个文件：每次建隧道时现读工作台管的那个 600 文件
// ~/.config/cluster-workbench/env.sh，里面的代理地址指向同一个端口且带着口令，就带上；读不到、不带口令、
// 端口对不上（端口重新分配过——那个端口现在可能是别人的隧道）都照旧不带。
// 已经在跑的守护进程用的是启动时加载的旧版本预加载：要在面板里重新启动一次才认得口令。
//
// 约束：源码会经 bash 的带引号 heredoc 写到远端，所以不得出现反引号和 "${"（便于 String.raw 内嵌），
// 也不得出现单独成行的 PRELOAD_EOF。
export const RELAY_PROXY_PRELOAD_FILE = ".paseo/relay-proxy.cjs";

export const RELAY_PROXY_PRELOAD_SOURCE = String.raw`"use strict";
// 让 Paseo 守护进程连官方中继（*.paseo.sh）时走本账号的反向隧道代理（127.0.0.1:PASEO_RELAY_PROXY_PORT）。
// 由集群运维工作台的「远端守护进程」启动脚本写入并通过 NODE_OPTIONS=--require 预加载；手工改动会被覆盖。
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { Duplex } = require("node:stream");

const PROXY_HOST = process.env.PASEO_RELAY_PROXY_HOST || "127.0.0.1";
const PROXY_PORT = Number(process.env.PASEO_RELAY_PROXY_PORT);
const PROXY_OK = Number.isInteger(PROXY_PORT) && PROXY_PORT >= 1 && PROXY_PORT <= 65535;
const MATCH = /(^|\.)paseo\.sh$/i;
const ENV_FILE = path.join(os.homedir(), ".config", "cluster-workbench", "env.sh");
const ENV_PROXY = /^export HTTPS_PROXY="http:\/\/([A-Za-z0-9._~%-]+:[A-Za-z0-9._~%-]*)@127\.0\.0\.1:(\d+)"$/m;

// 工作台受管 env.sh 里的代理口令（见文件头）。返回要加进 CONNECT 的那一行请求头，或空串。
function proxyAuthorizationLine() {
  try {
    const found = ENV_PROXY.exec(fs.readFileSync(ENV_FILE, "utf8"));
    if (!found || Number(found[2]) !== PROXY_PORT) return "";
    return "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(found[1])).toString("base64") + "\r\n";
  } catch (err) {
    return "";
  }
}

class ConnectTunnel extends Duplex {
  constructor(host, port) {
    super();
    this.ready = false;
    this.pending = [];
    this.head = Buffer.alloc(0);
    this.sock = net.connect(PROXY_PORT, PROXY_HOST);
    this.sock.write("CONNECT " + host + ":" + port + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\n" + proxyAuthorizationLine() + "\r\n");
    this.sock.on("data", (d) => this.onData(d));
    this.sock.on("end", () => this.push(null));
    this.sock.on("error", (e) => this.destroy(e));
    this.sock.on("close", () => this.destroy());
  }
  onData(d) {
    if (this.ready) {
      this.push(d);
      return;
    }
    this.head = Buffer.concat([this.head, d]);
    const end = this.head.indexOf("\r\n\r\n");
    if (end < 0) return;
    const line = this.head.subarray(0, end).toString().split("\r\n")[0];
    if (!/^HTTP\/1\.[01] 200/.test(line)) {
      this.destroy(new Error("proxy CONNECT failed: " + line));
      return;
    }
    const rest = this.head.subarray(end + 4);
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const [chunk, cb] of queued) this.sock.write(chunk, cb);
    if (rest.length) this.push(rest);
  }
  _read() {}
  _write(chunk, _enc, cb) {
    if (this.ready) this.sock.write(chunk, cb);
    else this.pending.push([chunk, cb]);
  }
  _destroy(err, cb) {
    this.sock.destroy();
    cb(err);
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
}

const originalConnect = tls.connect;
tls.connect = function patchedConnect(...args) {
  const opts = args[0] && typeof args[0] === "object" ? args[0] : null;
  const host = opts && (opts.servername || opts.host);
  if (!PROXY_OK || !opts || opts.socket || typeof host !== "string" || !MATCH.test(host)) {
    return originalConnect.apply(this, args);
  }
  const port = Number(opts.port) || 443;
  const tunnel = new ConnectTunnel(opts.host || host, port);
  const next = { ...opts, socket: tunnel, servername: opts.servername || host };
  delete next.host;
  delete next.port;
  return originalConnect.call(this, next, ...args.slice(1));
};
`;
