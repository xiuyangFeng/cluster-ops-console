// 本机网络地址变化检测（换校园网账号 / 换 Wi-Fi / 休眠唤醒后 DHCP 换了地址）。
// 隧道 ssh 的 TCP 连接绑定在旧地址上：地址一消失，这条连接就再也收不到服务器的回包，
// 只能等 ServerAlive 超时（约 1 分钟）才退出。主循环每拍比较一次地址集合，变化时通知各隧道
// 立即复核（见 tunnel-controller.handleNetworkChange）。
import os from "node:os";

// 只看对外地址：跳过回环（internal）与 IPv6 链路本地地址（fe80::，不会用来连服务器）。
export function listLocalAddresses(interfaces = {}) {
  const out = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.internal || typeof entry.address !== "string") continue;
      const v6 = entry.family === "IPv6" || entry.family === 6;
      if (v6 && /^fe80:/i.test(entry.address)) continue;
      out.add(entry.address);
    }
  }
  return [...out].sort();
}

// check()：首次调用只记基线返回 null；此后地址集合变化时返回 { removed, added, current }，未变返回 null。
export function createNetworkWatcher({ getInterfaces = () => os.networkInterfaces() } = {}) {
  let previous = null;
  function check() {
    let current;
    try {
      current = listLocalAddresses(getInterfaces());
    } catch {
      return null;
    }
    if (previous === null) {
      previous = current;
      return null;
    }
    const removed = previous.filter((address) => !current.includes(address));
    const added = current.filter((address) => !previous.includes(address));
    previous = current;
    if (!removed.length && !added.length) return null;
    return { removed, added, current };
  }
  return { check };
}
