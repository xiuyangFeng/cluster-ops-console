// 个人层 config.local.json 写入里"只属于控制面"的那部分（v2.57 终审）。
//
// 刻意不放进 config-loader.mjs：那个文件在 supervisor 与本地代理的热更新指纹闭包里（component-version.mjs
// 按静态 import 闭包算指纹），往里加一个只在控制面写入时才用的校验，就会让两个数据面组件的指纹都变、
// 升级时多出一次代理 / 隧道交接。同样的取舍见 modules/preferences-store.mjs（模块偏好）。
//
// 目前管一个字段：noProxyExtra（{ [serverId]: string[] }，登录引导测通的内网中转站，写进集群 env.sh 的
// NO_PROXY，重跑集群侧受管配置时据此带上）。它不在 config-loader 的 PERSONAL_FIELDS 里，也不进合并后的
// 运行配置——数据面用不到它；读取一律取个人层原始对象（cluster-env.noProxyExtraFor）。
//
// writePersonalConfig 与 config-loader 的同名函数签名相同，控制面（config-hot-reload / server-registry /
// 命令行向导）一律用这里的：不带 noProxyExtra 的补丁原样转交；带的先校验，再随其余字段同一次原子写落盘。
import * as nodeFs from "node:fs";
import { isNoProxyEntry } from "./cluster-env.mjs";
import { ConfigValidationError, writePersonalConfig as writeBasePersonalConfig } from "./config-loader.mjs";
import { backupPersonalConfig } from "./personal-config-backup.mjs";
import { isSafeServerId } from "./validators.mjs";

// 每台服务器的条数上限（与 cluster-env.renderNoProxy 的上限一致：写入放行的，渲染 env.sh 时也放行）。
export const NO_PROXY_EXTRA_MAX = 32;

// 写入校验：{ [serverId]: string[] } → { ok, value, errors }。条目去空白、去重；空数组的服务器删掉。
// 每条会被原样写进集群 env.sh 的双引号与 settings.json 的 NO_PROXY，口径就是 cluster-env 的 isNoProxyEntry
// （主机名 / .域名 / IPv4 / [IPv6] / CIDR / host:port；逗号、引号、空白、$ 一律拒绝）。
export function validateNoProxyExtraForWrite(map) {
  const fail = (message, field = "noProxyExtra") => ({ ok: false, value: null, errors: [{ field, message }] });
  if (!map || typeof map !== "object" || Array.isArray(map)) return fail("noProxyExtra 必须是 { 服务器 id: [主机, …] } 对象");
  const errors = [];
  const value = {};
  for (const [id, list] of Object.entries(map)) {
    const field = `noProxyExtra.${id}`;
    if (!isSafeServerId(id)) {
      errors.push({ field, message: "服务器 id 非法" });
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push({ field, message: "应为主机名数组" });
      continue;
    }
    const entries = [];
    for (const raw of list) {
      const entry = typeof raw === "string" ? raw.trim() : "";
      if (!isNoProxyEntry(entry)) errors.push({ field, message: `条目非法: ${JSON.stringify(raw)}` });
      else if (!entries.includes(entry)) entries.push(entry);
    }
    if (entries.length > NO_PROXY_EXTRA_MAX) errors.push({ field, message: `每台服务器最多 ${NO_PROXY_EXTRA_MAX} 条` });
    if (entries.length) value[id] = entries;
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 个人层当前内容：不存在 → {}；读不了 / 不是 JSON 对象 → null（交给 config-loader 按它的口径报错）。
function readCurrent(fs, localConfigPath) {
  let raw;
  try {
    raw = fs.readFileSync(localConfigPath, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" || /ENOENT/.test(String(err?.message || err)) ? {} : null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 一个只把"读个人层文件"换成给定快照的 fs，其余方法经原型委托给原 fs（备份、临时文件、rename 都落在真实
// 文件上）。config-loader 把 fs.readFileSync 当裸函数传下去，所以这里用闭包、不依赖 this。
function withPersonalSnapshot(fs, localConfigPath, snapshot) {
  const text = JSON.stringify(snapshot);
  return Object.create(fs, {
    readFileSync: { value: (file, ...rest) => (file === localConfigPath ? text : fs.readFileSync(file, ...rest)) },
  });
}

// 把 config-loader 写前那一次 copyFileSync(个人配置 → .bak) 变成「先留一份带时间戳的备份，再照常复制 .bak」。
// 其余方法经原型委托给 fsImpl；备份用原始的 fs（盘上的真实内容）。
function withRotatingBackup(fsImpl, fs, localConfigPath) {
  const bakPath = `${localConfigPath}.bak`;
  return Object.create(fsImpl, {
    copyFileSync: {
      value: (from, to, ...rest) => {
        if (from === localConfigPath && to === bakPath) backupPersonalConfig(localConfigPath, { fs });
        return fsImpl.copyFileSync(from, to, ...rest);
      },
    },
  });
}

// 与 config-loader.writePersonalConfig 同签名。补丁里带 noProxyExtra 时：
//   - 与文件里现有的值逐字相同（设置页整份保存、服务器注册表的 {...current, ...patch} 都是原样带回）→ 不算
//     改动，转交 config-loader（它对不认识的字段原样保留）；没动这个字段的保存不该被里面手写的旧条目卡住。
//   - 确有改动 → 先校验（不合法即抛，不发生任何写入），再把校验后的值垫进 config-loader 读到的"当前内容"。
//     config-loader 对不认识的字段原样保留，于是它随其余字段在同一次读、同一次 revision 核对、同一次原子写
//     里落盘，.bak 仍是写入前的原文。
//
// 写前另留一份带时间戳的备份（v2.64，personal-config-backup.mjs：config-backups/ 下最近 5 份）。时机借 config-loader
// 自己的写前 .bak：它在全部校验与版本核对通过、真正写盘之前做一次 copyFileSync(个人配置, 个人配置.bak)，这里在那一刻
// 多留一份——被拒绝的保存不留备份，与 .bak 同一个时机。备份读的是盘上的真实文件（原 fs），不是垫进去的快照。
export function writePersonalConfig({ localConfigPath, patch, expectedRevision, teamServerIds, fs = nodeFs }) {
  const write = (input, fsImpl) => writeBasePersonalConfig({ localConfigPath, patch: input, expectedRevision, teamServerIds, fs: withRotatingBackup(fsImpl, fs, localConfigPath) });
  if (!isPlainObject(patch) || !Object.hasOwn(patch, "noProxyExtra")) return write(patch, fs);
  const { noProxyExtra, ...rest } = patch;
  const current = readCurrent(fs, localConfigPath);
  if (current === null || JSON.stringify(noProxyExtra) === JSON.stringify(current.noProxyExtra)) return write(rest, fs);
  const checked = validateNoProxyExtraForWrite(noProxyExtra);
  if (!checked.ok) throw new ConfigValidationError("内网直连名单未通过校验", checked.errors);
  return write(rest, withPersonalSnapshot(fs, localConfigPath, { ...current, noProxyExtra: checked.value }));
}
