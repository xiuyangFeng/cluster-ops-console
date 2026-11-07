// 每台服务器同一时刻只允许一个 CLI 任务（安装 / 更新 / 回滚 / 登录，第 2 期数据契约）。
// 全仓只有这一份实现、一个实例：lib/probes.mjs 创建（toolkit.cliTaskLock），安装业务层（install-service.mjs）
// 与登录服务（login.mjs，server/start.mjs 装配时注入同一实例）共用——安装进行中不能登录，反之亦然。
// 「撤销接入」（onboarding-guide/access.mjs，v2.62）执行期间也占这把锁：它删的 env.sh 与 keys/ 正是安装 / 登录要读写的。
// 只在本进程内存里：控制面重启后锁自然释放；远端还在跑的首选路径安装任务由安装预检发现并接管。
//
// 「发布到团队缓存」（publish）与「测试对话」（smoke，v2.89）也占：前者要上传，后者要读 env.sh 与 keys/。
// 占用者信息 holder：{ kind: "install" | "rollback" | "login" | "undo" | "publish" | "smoke", cli, jobId?, method?, since }（undo 没有 cli）。
// 两种取法：acquire（占用中抛 status 409、带 busy 的错误，安装 / 回滚用）与 tryAcquire（占用中返回 null，
// 登录服务自己组错误码 busy）；提示文案统一由 describeCliTask / busyMessage 按 kind 给。

export const CLI_TASK_KINDS = Object.freeze(["install", "rollback", "login", "undo", "publish", "smoke"]);

const KIND_TEXT = Object.freeze({ install: "安装 / 更新", rollback: "回滚", login: "登录", undo: "撤销接入", publish: "发布到团队缓存", smoke: "测试对话" });

// 「codex 的安装 / 更新」「Claude 的登录」；cli 缺省只说种类。
export function describeCliTask(holder) {
  if (!holder) return "";
  const what = KIND_TEXT[holder.kind] || String(holder.kind || "任务");
  return holder.cli ? `${holder.cli} 的${what}` : what;
}

export function busyMessage(holder) {
  return `这台服务器上正在进行 ${describeCliTask(holder)}，请等它结束再试`;
}

export function createCliTaskLock({ now: defaultNow = Date.now } = {}) {
  const held = new Map(); // serverId → { kind, cli, jobId, method, since, token }

  const publicView = (cur) => (cur
    ? { kind: cur.kind, cli: cur.cli, ...(cur.jobId != null ? { jobId: cur.jobId } : {}), ...(cur.method != null ? { method: cur.method } : {}), since: cur.since }
    : null);

  // 占到 → release()（幂等，只释放自己那次占用）；占用中 → null。
  function tryAcquire(serverId, { kind, cli = null, jobId = null, method = null, now = defaultNow } = {}) {
    if (held.has(serverId)) return null;
    const token = Symbol("cli-task");
    held.set(serverId, { kind, cli, jobId, method, since: now(), token });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (held.get(serverId)?.token === token) held.delete(serverId);
    };
  }

  // 同 tryAcquire，占用中抛 409（文案说明谁在占用，busy 带占用者的公开信息）。
  function acquire(serverId, info = {}) {
    const release = tryAcquire(serverId, info);
    if (release) return release;
    const busy = current(serverId);
    throw Object.assign(new Error(busyMessage(busy)), { status: 409, busy });
  }

  function current(serverId) {
    return publicView(held.get(serverId));
  }

  return { acquire, tryAcquire, current };
}
