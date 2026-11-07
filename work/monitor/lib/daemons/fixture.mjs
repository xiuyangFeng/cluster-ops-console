// 远端守护进程在 fixture 模式下的假数据（v2.62）：不发 SSH、不起进程、不碰任何端口与文件。
//
// fixture 模式是热更新的包冒烟、自更新的目标版本自检、浏览器冒烟与界面预览用的隔离实例，约定是「绝不碰进程、
// 不做真实探测」。可这块面板在「服务器」页可见时每 60 秒读一次状态——那是一次真实的 SSH，而 fixture 监控读的
// 可能就是团队配置：不拦的话，打开页面就会连到真实集群（v2.55–v2.61 一直如此）。v2.62 起这里还能起转发用的
// ssh，更不能漏。所以 fixture 模式下守护进程服务（service.mjs）的状态、启动、服务列表与转发全部改走这里：
//   - remote(action)：顶替「发一次 SSH 跑状态 / 启动脚本」，返回一段与真实远端输出同形的文本，照常走解析。
//     Paseo 在运行、T3 Code 起初没在运行（界面上能看到「启动」并走一遍确认）；「启动」只改这里的内存状态。
//   - forwards：真实的转发管理器，但它通向系统的四个出口全部换成假的——spawn 得到一个不存在的「子进程」，
//     ssh -G 预检、挑本机端口、探测端口都只返回固定结果，进程注册表不给（不写任何文件）。上限、到点收回、
//     关闭、随列表收回这些逻辑照常生效；返回的本机端口只是个看起来像样的数字，没有任何东西在监听它。
import { EventEmitter } from "node:events";

import { createServiceForwards } from "./forwards.mjs";

// 三个有代表性的服务：只对集群本机开放的报告页、对所有网卡开放的面板、只绑 ::1 的开发服务器。
const SERVICE_LINES = Object.freeze([
  'ss=LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("python",pid=41001,fd=3))',
  'ss=LISTEN 0 5 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=41002,fd=4))',
  'ss=LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=41003,fd=20))',
  "proc=41001\t/home/fixture/reports/demo\tpython -m http.server 8814 --bind 127.0.0.1",
  "proc=41002\t/home/fixture/dashboard\tpython serve.py --host 0.0.0.0 --port 8765",
  "proc=41003\t/home/fixture/web\tnode node_modules/.bin/vite --port 5173",
  "age=41001 11520",
  "age=41002 190000",
  "age=41003 600",
  "svc.home=/home/fixture",
  "svc.state=ok",
]);

// 不存在的「子进程」：没有 pid、没有输出；被要求结束时如实报告退出。
function inertChild() {
  const child = new EventEmitter();
  child.pid = null;
  child.stderr = null;
  child.kill = (signalName = "SIGTERM") => {
    setImmediate(() => child.emit("exit", null, signalName));
    return true;
  };
  return child;
}

export function createDaemonsFixture({ now = Date.now, log = () => {} } = {}) {
  const running = new Set(["paseo"]);

  // action：null = 只查状态；否则是要启动的守护进程 id。返回形状同一次成功的 SSH。
  function remote(action = null) {
    const lines = ["v=1"];
    if (action) {
      lines.push(running.has(action) ? "result=already" : "result=started");
      running.add(action);
    }
    const t3 = running.has("t3code");
    lines.push(
      "paseo.bin=1", "paseo.daemon=running", "paseo.version=0.10.3", "paseo.port=1",
      "t3code.bin=1", "t3code.binver=0.0.45", `t3code.port=${t3 ? 1 : 0}`, `t3code.proc=${t3 ? 1 : 0}`,
      ...(t3 ? ["t3code.version=0.0.45"] : []),
      ...SERVICE_LINES,
      "end=1",
    );
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "", timedOut: false, truncated: false };
  }

  let picked = 0;
  const forwards = createServiceForwards({
    registry: null,
    sshArgsFor: (server) => [server?.host],
    sshCommand: "fixture-ssh", // 只会出现在日志里，从不执行
    spawnImpl: () => inertChild(),
    execImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    pickPort: async () => 52000 + (picked++ % 1000),
    probePort: async () => true,
    log,
    now,
    timings: { noAuthLineMs: 0, settleMs: 0, pollMs: 1, killGraceMs: 50 },
  });

  return { remote, forwards };
}
