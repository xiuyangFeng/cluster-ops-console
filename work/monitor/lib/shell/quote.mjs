// POSIX sh 单引号包裹：整体放进 '…'，内部的 ' 写成 '\''（闭合 → 转义的单引号 → 重新打开）。
// 结果可安全拼进 sh 命令串或给用户复制到终端；单引号内没有任何展开，$HOME / ` / ; 都按字面。
// 只适用于 POSIX sh 系（bash/zsh/dash），不适用于 PowerShell / cmd。
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
