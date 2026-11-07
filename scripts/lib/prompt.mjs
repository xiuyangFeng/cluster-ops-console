// scripts/lib/prompt.mjs —— CLI 脚本共用的终端提问（仅脚本侧使用）。
// 每次提问临时建一个 readline 接口、答完即关：不常驻占住 stdin，脚本结束时进程能正常退出。
import readline from "node:readline";

// 读一行输入，原样返回（不 trim；需要时由调用方处理）。
export function askLine(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

// 只有 y / yes（不区分大小写，允许前后空白）算同意；直接回车与其它输入一律按"否"——
// 用于删除文件、交接代理、覆盖配置这类默认不做的动作。ask 可注入（向导单测用假实现）。
export async function confirmYes(query, ask = askLine) {
  return /^y(es)?$/i.test(String(await ask(query)).trim());
}

// 不回显地读一行（API key / 令牌用）：终端下切 raw 模式逐字收，退格可删、Ctrl-C 照常中断、整段粘贴也行；
// 标准输入不是终端（管道 / 测试）时按普通一行读。返回原样字符串，调用方负责 trim 与用完即弃。
export function askHidden(query, { input = process.stdin, output = process.stdout } = {}) {
  output.write(query);
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, terminal: false });
    return new Promise((resolve) => {
      let answered = false;
      rl.once("line", (line) => {
        answered = true;
        rl.close();
        resolve(line);
      });
      rl.once("close", () => {
        if (!answered) resolve("");
      });
    });
  }
  return new Promise((resolve) => {
    let value = "";
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    const finish = (interrupted) => {
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\n");
      if (interrupted) process.kill(process.pid, "SIGINT");
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(false);
        if (ch === "\u0003") return finish(true);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}
