// 标识符校验的单一事实源（零依赖叶子模块：数据面 supervisor / 本地代理的 import 闭包也会
// 收录它，不得在这里引入任何副作用或额外依赖）。
//
// serverId 会派生注册表记录名（tunnel.<id>，落盘为 tunnel.<id>.pid.json）与日志键：
// 只放行 [\w.-]——挡住路径穿越（"../x"），也保证 Windows 文件名合法（冒号非法，同事有 Windows 机器）。
// 两种口径并存，调用方按原语义选用，**不要互换**：
//   - 不限长（SERVER_ID_PATTERN）：个人层条目合并/写入、隧道目标解析、注册表命名的历史口径；
//   - 1–64（BOUNDED_SERVER_ID_PATTERN）：团队层 config.json 加载、热载的事件生命周期快照等
//     "外来输入"入口——多一道长度上限，防超长 id 撑爆文件名与日志。
export const SERVER_ID_PATTERN = /^[\w.-]+$/;
export const MAX_SERVER_ID_LENGTH = 64;
export const BOUNDED_SERVER_ID_PATTERN = /^[\w.-]{1,64}$/;

// 非字符串一律 false（不做 String() 隐式转换——数字 id 不是合法配置）。
export function isSafeServerId(value) {
  return typeof value === "string" && SERVER_ID_PATTERN.test(value);
}

export function isBoundedServerId(value) {
  return typeof value === "string" && BOUNDED_SERVER_ID_PATTERN.test(value);
}

// 拼文件名前的最后一道闸：团队层手编 id 写坏时直接抛，而不是静默生成怪文件名。
// 与 isSafeServerId 不同，这里先 String() 归一（历史行为：数字 id 会被接受为其十进制串）。
export function assertSafeServerId(serverId) {
  const id = String(serverId ?? "");
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new Error(`unsafe serverId: ${JSON.stringify(serverId)}，只允许 [\\w.-] 字符`);
  }
  return id;
}

// TCP 端口：1–65535 的整数。isPort 不做类型转换（字符串 "8888" 不算）；
// toPort 先 Number() 归一再判，非法一律 null。
export function isPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function toPort(value) {
  const port = Number(value);
  return isPort(port) ? port : null;
}

// 凭据引用：vault:<id>（系统安全存储）/ mem:<id>（仅进程内存）。只是"引用"，绝不含口令本身。
export const AUTH_REF_PATTERN = /^(vault|mem):[\w.-]+$/;

export function isAuthRef(value) {
  return typeof value === "string" && AUTH_REF_PATTERN.test(value);
}
