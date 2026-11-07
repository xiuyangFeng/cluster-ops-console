// 自更新用到的 git 调用（v2.59）：固定参数、绝不交互、输出可解析。
//
// 只有源码安装（git clone 出来的目录）才会走到这里。所有调用都是参数数组（不经 shell），仓库路径用 -C 传，
// 提交号进命令前先过 isGitSha。环境里钉死：
//   GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never   凭证失效时直接失败，不在后台卡在「请输入用户名」
//   GIT_SSH_COMMAND（未自定义时）                    ssh 远端同样不等密码
//   LC_ALL=C                                         报错文字是英文，classifyFetchFailure 才认得出
// 每次调用另有一道到点必回的期限（见 createGit），联网的调用带 http.lowSpeed*：对端收了连接却不回话时
// git 自己在 30 秒没有数据后放弃。
import { execFileWithTimeout } from "../exec.mjs";

const GIT_SHA = /^[0-9a-f]{40}$/;
export const isGitSha = (value) => typeof value === "string" && GIT_SHA.test(value);

// 上游代理只接受 http(s)://host:port（来自个人层出网设置，已经过校验；这里再挡一次，免得把怪东西拼进 -c）。
const PROXY_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;

export function gitEnv(base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", LANG: "C" };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";
  return env;
}

// exec 的超时只杀 git 本身，并且要等它的输出管道关闭才返回：git-remote-https 这类子进程还拿着管道时
// 会一直等下去，之后的检查与更新全都排在这一次后面（界面上的更新按钮随之消失，直到重启）。
// 所以超时之外再留这点余量，到点不管 exec 回没回都按超时返回。
const HARD_DEADLINE_GRACE_MS = 3000;

// → run(args, { timeoutMs, proxy }) → { ok, code, stdout, stderr, timedOut }。永不 reject。
export function createGit({ root, exec = execFileWithTimeout, env = process.env, graceMs = HARD_DEADLINE_GRACE_MS } = {}) {
  return async function run(args, { timeoutMs = 15000, proxy = null } = {}) {
    const prefix = ["-C", root, "-c", "core.quotepath=off", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"];
    if (proxy && PROXY_URL.test(proxy)) prefix.push("-c", `http.proxy=${proxy}`);
    let res;
    let timer = null;
    // 不 unref：这道期限必须自己撑得住事件循环——exec 迟迟不返回、又没有别的句柄活着时，
    // unref 过的定时器不会触发，等它的人就永远等下去（Node 22 的测试进程里正是这样整文件被取消）。
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", timedOut: true }), timeoutMs + graceMs);
    });
    try {
      res = await Promise.race([exec("git", [...prefix, ...args], { timeoutMs, env: gitEnv(env), maxOutputBytes: 512 * 1024 }), deadline]);
    } catch (err) {
      res = { code: 1, stdout: "", stderr: String(err?.message || err), timedOut: false };
    } finally {
      clearTimeout(timer);
    }
    return {
      ok: res?.code === 0 && !res?.timedOut,
      code: res?.code ?? null,
      stdout: String(res?.stdout ?? ""),
      stderr: String(res?.stderr ?? ""),
      timedOut: Boolean(res?.timedOut),
    };
  };
}

// 文本里内嵌在地址中的账号口令（https://user:token@host/…）一律抹掉，再给界面与日志看。
export function redactUrlCredentials(text) {
  return String(text ?? "").replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");
}

// 远端地址（git remote get-url 的输出）→ 去掉凭证的一行。
export function sanitizeRemoteUrl(url) {
  return redactUrlCredentials(String(url ?? "").trim().split(/\s/)[0] || "").slice(0, 200);
}

// 「没入库的文件会被覆盖」时 git 列出的文件名。两种写法：合并时是一句开头 + 每行一个文件（制表符缩进），
// reset 时是每个文件一句 "Untracked working tree file 'x' would be overwritten"。不是这种失败 → []。
function untrackedFilesInTheWay(text) {
  const rows = text.split("\n");
  const head = rows.findIndex((row) => /untracked working tree files would be overwritten/i.test(row));
  if (head >= 0) {
    const files = [];
    for (const row of rows.slice(head + 1)) {
      if (!/^\s+\S/.test(row)) break;
      files.push(row.trim());
    }
    return files;
  }
  return [...text.matchAll(/Untracked working tree file '(.+)' would be overwritten/gi)].map((match) => match[1]);
}

// 纯函数：git 失败时的 stderr → 给人看的一句原因。git 的报错是「error: / fatal: 一句原因」后面跟几行提示，
// 最后一行多半是套话（"Aborting"、"and the repository exists."），所以取第一条 error: / fatal:，
// 一条都没有才退到最后一个非空行，全空用 fallback。没入库的文件挡路时把文件名和下一步一起说出来
// （这种失败挪走文件就能解决，光说「会被覆盖」不说是哪几个没法照做）。地址里的凭证照例抹掉，长度有上限。
export function describeGitFailure(stderr, fallback = "") {
  const text = redactUrlCredentials(stderr);
  const files = untrackedFilesInTheWay(text);
  if (files.length) {
    const names = `${files.slice(0, 5).join("、")}${files.length > 5 ? ` 等 ${files.length} 个` : ""}`.slice(0, 240);
    return `这些没入库的文件会被覆盖：${names}。把它们移到别处或删掉后再试一次`;
  }
  const rows = text.split("\n").map((row) => row.trim()).filter(Boolean);
  return (rows.find((row) => /^(?:error|fatal):/i.test(row)) || rows.at(-1) || fallback).slice(0, 200);
}

// 按名字取一条分支（fetch 时写明 refs/heads/x）而远端没有它：git 说 "couldn't find remote ref"。
// 这不是连不上，是那条分支不存在——更新通道据此分清「发布方还没建 stable」与「取不到」。
export function isMissingRemoteRef(res) {
  return !res?.timedOut && /couldn't find remote ref/i.test(`${res?.stderr || ""}\n${res?.stdout || ""}`);
}

// git fetch 失败的归因 → { code, message }。message 给人看，不带远端地址里的凭证。
export function classifyFetchFailure(res) {
  if (res?.timedOut) return { code: "timeout", message: "连接 GitHub 超时，稍后会自动再查；也可以检查一下本机网络或代理" };
  const text = `${res?.stderr || ""}\n${res?.stdout || ""}`;
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey|Invalid username or (?:password|token)|HTTP 401|returned error: 401/i.test(text)) {
    return { code: "auth", message: "GitHub 凭证不可用（没登录或令牌过期）。在终端进这个目录执行一次 git pull，按提示登录后再试" };
  }
  if (/Repository not found|returned error: 40[34]|does not appear to be a git repository/i.test(text)) {
    return { code: "no-access", message: "访问不到更新仓库：确认已被加为仓库协作者，并用同一个 GitHub 账号登录过" };
  }
  if (/Could not resolve host|Failed to connect|Connection (?:refused|reset|timed out)|unable to access|Network is unreachable|Operation timed out|SSL|TLS|early EOF|RPC failed/i.test(text)) {
    return { code: "offline", message: "连不上 GitHub，稍后会自动再查；也可以检查一下本机网络或代理" };
  }
  return { code: "fetch-failed", message: `检查更新失败：${describeGitFailure(text, `git 退出码 ${res?.code ?? "未知"}`)}` };
}
