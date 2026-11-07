// 远端脚本统一经 `sh -c '<脚本>'` 执行（v2.54 终审）：ssh 把命令串原样交给对方的登录 shell
// （bash / zsh / tcsh / csh 都可能），`if/elif/fi`、`for`、`2>/dev/null`、`$(…)` 在 csh 里不是合法语法——
// 显式换成 sh 才能保证语义一致。脚本整体单引号包裹（shellSingleQuote），内部的 $ ~ ` ; 等都按字面
// 交给 sh，由 sh 自己展开：`~` 与 `$HOME` 照常是家目录，`$$` 是这层 sh 的 pid（每次 ssh 都是新进程，
// 临时文件 / 备份名照样唯一）。
//
// csh/tcsh 的单引号挡不住两样东西，要特殊处理：
//   - 换行：单引号里不允许裸换行（报 "Unmatched '."），而 `\`+换行在 csh 里被换成换行、在 bash/zsh/sh
//     里原样保留（随后被 sh 当作续行删掉）——同一串字节两种解读。所以把脚本的每个换行都写成 `\`+换行，
//     并保证它只落在"换行与空格等价"的位置：行尾已经是 `;` `&&` `||` `|` `&` `{` `(` 或 then / do / else
//     时直接续行，否则先补一个 `;`。无论对方登录 shell 怎么解读，sh 执行的都是同一段程序；dry-run
//     预览也仍按行可读。
//   - `!`：csh 在 `-c` 下照样做历史替换，单引号里的 `[!0-9]` 会报 "0: Event not found."。`!` 一律写成
//     `'\!'`（闭合单引号 → 转义的 ! → 重新打开）：引号外的 `\!` 在 csh 与 POSIX sh 系里都还原成 `!`。
//
// 脚本约束（违反时抛错或语义不保）：不能有 heredoc、跨行的引号字符串、单独成行的 case 模式与 # 注释
// （续行后注释会吞掉其后的全部命令；整行注释直接拒绝）。行尾自带 `\` 的行视为调用方写好的续行，
// `\` 之前同样必须是上述 token。
//
// 不放进 quote.mjs：quote.mjs 在 supervisor 的热更新指纹闭包里（经 ssh-askpass），这里只给向导 /
// 引导用，改它不该让数据面走平滑交接。
import { shellSingleQuote } from "./quote.mjs";

// 行尾是这些 token 时 sh 允许其后直接换行：续行即可，不必补分号。
const CONTINUATION_TAIL = /(?:[;|&]|(?:^|\s)[{(]|(?:^|;)\s*(?:then|do|else))$/;

function joinShLines(script) {
  const raw = Array.isArray(script) ? script.join("\n") : String(script ?? "");
  const lines = raw.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim() !== "");
  return lines
    .map((line, i) => {
      if (/^\s*#/.test(line)) throw new Error(`远端脚本不能含整行注释（续行后会吞掉其后的命令）: ${line}`);
      const continued = line.endsWith("\\");
      const body = continued ? line.slice(0, -1).replace(/\s+$/, "") : line;
      if (i === lines.length - 1) {
        if (continued) throw new Error(`远端脚本最后一行不能以续行符结尾: ${line}`);
        return body;
      }
      if (CONTINUATION_TAIL.test(body)) return `${body} \\`;
      if (continued) throw new Error(`续行只能落在 ; && || | & { ( then do else 之后（csh 会把它当成换行）: ${line}`);
      return `${body}; \\`;
    })
    .join("\n");
}

// script：一段脚本文本或"一行一个元素"的数组。返回可直接交给 ssh 的命令串。
export function wrapSh(script) {
  return `sh -c ${shellSingleQuote(joinShLines(script)).replaceAll("!", "'\\!'")}`;
}
