// 远端写文件的单条原子命令生成（纯函数）：配置向导（scripts/setup/routing.mjs）与之后 App 内引导共用。
// 原先只在 routing.mjs 里；集群侧受管配置（cluster-env.mjs）要在 lib 内组装"远端命令步骤列表"，
// lib 不能反向 import scripts/（打包闭包只收 work/monitor/），故下沉到这里，routing.mjs 改为 re-export
// （导出名不变；默认参数下 buildRemoteReplaceFileCommand 的输出逐字不变）。
//
// 共同约束（E4）：全程只对 `<target>.tmp.$$` 临时文件写入，最后 `mv` 原子替换——绝不出现裸
// `cat > <target>`（慢网下客户端超时把 ssh 进程 SIGTERM 掉，会截断正在写入的目标文件；写临时
// 文件再 mv 则要么整体成功、要么目标文件完全不受影响）。目标文件存在时先 `cp -p` 一份带时间戳的
// `.bak.<epoch>.<pid>` 备份。路径按原样插值（调用方只传 `~/…` 形式的常量路径，不含空白与引号）。
//
// 这里产出的都是 POSIX sh 片段（if/fi、2>/dev/null、$(…)），交给 ssh 前由调用方经 ./wrap-sh.mjs
// 包成 `sh -c '…'`——对方登录 shell 可能是 tcsh / csh。片段只在 `&& \`+换行 处折行，符合 wrapSh 的续行约束。

// marker 只允许安全字符：它会被放进 awk -v / grep 的双引号参数里。
const SAFE_MARKER = /^[A-Za-z0-9 ._-]+$/;
const SAFE_MODE = /^[0-7]{3,4}$/;

function assertMarker(marker) {
  if (!SAFE_MARKER.test(String(marker || ""))) throw new Error(`marker 含不安全字符: ${marker}`);
}

function assertMode(mode, label) {
  if (mode !== undefined && !SAFE_MODE.test(String(mode))) throw new Error(`${label} 非法: ${mode}`);
}

// 备份文件名带上远端 shell 的 $$：同一秒内对同一文件的两次改写（如先追加引入块、再剥离旧块）
// 各自留一份，不会让第二份把最初的原文备份覆盖掉。每次 ssh 都是新 shell，$$ 不同（包在 sh -c 里时
// 是这层 sh 的 pid，同样每次不同；$(…) 子 shell 里的 $$ 仍是外层 sh 的 pid，同一条命令内一致）。
export function backupPath(targetFile) {
  return `${targetFile}.bak.$(date +%s).$$`;
}

export function markerLines(marker) {
  return { begin: `# >>> ${marker} >>>`, end: `# <<< ${marker} <<<` };
}

// 剥离 marker 包裹块的 awk 程序（读文件、输出剥离后的全文）。
function stripAwk(marker) {
  const { begin, end } = markerLines(marker);
  return `awk -v b="${begin}" -v e="${end}" 'BEGIN{skip=0} $0==b{skip=1;next} $0==e{skip=0;next} skip{next} {print}'`;
}

// 生成一条在服务器上原子完成"备份 + 剥离旧 marker 块 + 写回"的 shell 命令串，交给 ssh 一次执行
// （不再需要先 SSH 读回本地 upsert 再 SSH 写回两个往返，也就不存在两次 SSH 之间的 TOCTOU）。设计要点：
//   1. tmp + mv 原子替换（见文件头）；tmp 先 `cp -p` 自目标文件再被 `>` 截断重写，从而继承目标文件的
//      权限位——集群 umask 是 0002，不这样做每写一次 rc 文件就会从 644 变成 664。
//   2. blockContent 用 base64 内嵌在命令串里（而非 heredoc）：避免 heredoc 终止符与自身内容意外
//      冲突、避免其在 `&&` 命令链中的换行/引用坑，且 base64 字母表天然对 shell 特殊字符免疫。
//   3. marker 包裹的旧块在写回前用 awk 剥离，重复对同一 targetFile 执行不会让内容越叠越多（幂等）。
// position: "append"（默认，bashrc——被 source，块追加到末尾即可）
//         | "after-shebang"（被直接 exec 的 shell 包装脚本——块必须插在 shebang 之后、exec 之前，
//           否则追加到 exec 行之后永远不执行，export 成死代码）。
export function buildRemoteUpsertCommand({ targetFile, blockContent, marker, position = "append" }) {
  assertMarker(marker);
  const { begin, end } = markerLines(marker);
  const trimmedBlock = String(blockContent || "").replace(/\n$/, "");
  const fullBlock = `${begin}\n${trimmedBlock}\n${end}\n`;
  const encodedBlock = Buffer.from(fullBlock, "utf8").toString("base64");
  const tmpFile = `${targetFile}.tmp.$$`;
  const bakFile = backupPath(targetFile);
  const backupAndKeepMode = `if [ -f ${targetFile} ]; then cp -p ${targetFile} ${bakFile} && cp -p ${targetFile} ${tmpFile}; fi`;

  if (position === "after-shebang") {
    const strippedFile = `${targetFile}.stripped.$$`;
    return [
      backupAndKeepMode,
      `{ if [ -f ${targetFile} ]; then ${stripAwk(marker)} ${targetFile}; fi; } > ${strippedFile}`,
      `{ head -n 1 ${strippedFile}; printf '%s' '${encodedBlock}' | base64 -d; tail -n +2 ${strippedFile}; } > ${tmpFile}`,
      `mv ${tmpFile} ${targetFile}`,
      `rm -f ${strippedFile}`,
    ].join(" && \\\n");
  }

  return [
    backupAndKeepMode,
    `{ if [ -f ${targetFile} ]; then ${stripAwk(marker)} ${targetFile}; fi; } > ${tmpFile}`,
    `printf '%s' '${encodedBlock}' | base64 -d >> ${tmpFile}`,
    `mv ${tmpFile} ${targetFile}`,
  ].join(" && \\\n");
}

// 只剥离、不写入：文件存在且确有该 marker 起始行时才动它（备份 + 继承权限的 tmp + mv），
// 否则什么都不做、退出码 0——撤销与"清理旧向导遗留块"不该给没写过东西的文件平添一份备份。
// requireShebang：目标可能是原生二进制（codex 的独立安装版就是 ELF）时只处理以 "#!" 开头的
// shell 脚本，绝不把 awk 的文本输出写回一个可执行文件。shebang 判定排在 grep 之前（&& 短路）：
// 先只读 2 个字节确认是脚本，才去 grep 全文——否则每次都要把上百 MB 的 ELF 整个读一遍。
export function buildRemoteStripBlockCommand({ targetFile, marker, requireShebang = false }) {
  assertMarker(marker);
  const { begin } = markerLines(marker);
  const tmpFile = `${targetFile}.tmp.$$`;
  const bakFile = backupPath(targetFile);
  const conditions = [`[ -f ${targetFile} ]`];
  if (requireShebang) conditions.push(`[ "$(head -c 2 ${targetFile})" = '#!' ]`);
  conditions.push(`grep -qxF "${begin}" ${targetFile}`);
  const body = [
    `cp -p ${targetFile} ${bakFile}`,
    `cp -p ${targetFile} ${tmpFile}`,
    `${stripAwk(marker)} ${targetFile} > ${tmpFile}`,
    `mv ${tmpFile} ${targetFile}`,
  ].join(" && ");
  return `if ${conditions.join(" && ")}; then ${body}; fi`;
}

// 整文件读改写场景（如 ~/.zcode/v2/setting.json 的 JSON 合并写回）的原子替换命令：
// mkdir -p 目标目录 + 旧文件带时间戳备份 + 内容 base64 内嵌写入 tmp($$) + mv 原子替换。
// 不做 marker 剥离——调用方在本地完成"读回 → 合并 → 生成全文"。默认参数下输出与搬迁前逐字一致（备份名仍是
// `.bak.<epoch>`：这两处每轮只写一次）
// （reclaude drop-in、zcode 两步依赖它）；新增的可选项只给受管文件用：
//   mode     —— 目标文件最终权限（如 "600"）；给出时整条命令先 `umask 077`，tmp 从创建起就不可被他人读，
//               再 chmod 后 mv，杜绝"先以 664 落盘、再收紧"的窗口（第 4 期 env.sh 会带代理口令）。
//   dirMode  —— 目标目录权限（如 "700"）；`mkdir -p` 对已存在目录不改权限，所以另 chmod 一次。
//   backup   —— false 时不留 .bak（整文件由我们生成、没有用户手写内容可丢的受管文件）。
export function buildRemoteReplaceFileCommand({ targetFile, content, mode, dirMode, backup = true }) {
  assertMode(mode, "mode");
  assertMode(dirMode, "dirMode");
  const encoded = Buffer.from(String(content ?? ""), "utf8").toString("base64");
  const dir = targetFile.replace(/\/[^/]+$/, "") || ".";
  const tmpFile = `${targetFile}.tmp.$$`;
  const bakFile = `${targetFile}.bak.$(date +%s)`;
  const steps = [];
  if (mode) steps.push("umask 077");
  steps.push(dirMode ? `mkdir -p ${dir} && chmod ${dirMode} ${dir}` : `mkdir -p ${dir}`);
  if (backup) steps.push(`if [ -f ${targetFile} ]; then cp -p ${targetFile} ${bakFile}; fi`);
  steps.push(`printf '%s' '${encoded}' | base64 -d > ${tmpFile}`);
  if (mode) steps.push(`chmod ${mode} ${tmpFile}`);
  steps.push(`mv ${tmpFile} ${targetFile}`);
  return steps.join(" && \\\n");
}

// 内容经 ssh 标准输入送达的整文件原子替换（runSsh 的 input）。用于可能很大的文件——内嵌 base64 时
// 整条命令是远端 `sh -c` 的单个参数，Linux 单参数上限 128KB（MAX_ARG_STRLEN），带长 hooks 的
// ~/.claude/settings.json 已有 45KB。也顺带让命令串本身不含文件内容（预览 / 日志里不会出现密钥）。
// 断线时远端 cat 读到的是 EOF 而非错误，会"成功"写出半截文件——所以 mv 前必须核对字节数，
// 不符就删掉 tmp、以非零退出，目标文件不受影响。
// 新文件在 umask 077 下创建（600）；已有文件的权限位经 `cp -p` 继承（settings.json 常是 600，
// 可能含 API key，绝不能被重写成 664）。
//   mode —— 目标文件最终权限（如 "600"，要往里写 key 时用）。给出时 tmp 不再继承原文件权限：集群 umask 是
//           0002，原文件常是 664，继承过来再写入就是"含 key 的内容先以 664 落盘、mv 之后才收紧"的窗口
//           （v2.57 终审）。改为先建空 tmp 并 chmod，之后才写内容；mv 过去的就已经是这个权限。
//           备份同样收紧到这个权限：要求 mode 就是在说"这个文件里有密钥"，旧文件若已含 key 且是 664，
//           `cp -p` 出来的备份会把这份 664 一直留在盘上。不给 mode 时输出逐字不变。
//           备份名里有 $(date +%s)，这里要用它两次（cp 与 chmod）：先存进 shell 变量、只求值一次。
//           各写一遍的话，两次求值之间跨了秒，chmod 找的就是另一个不存在的名字，整条命令失败。
//   dirMode —— 目标目录权限（如 "700"）；`mkdir -p` 对已存在目录不改权限，所以另 chmod 一次。
//   backup  —— false 时不留 .bak：整文件由我们生成、没有用户手写内容可丢的受管文件用（v2.62 带代理口令的
//              env.sh 走这条路——内容里有口令，不能像不带口令时那样把 base64 内嵌进命令行；也不该每同步
//              一次就在盘上多留一份含旧口令的备份）。两项都不给时输出逐字不变。
export function buildRemoteReplaceFileFromStdinCommand({ targetFile, byteLength, mode, dirMode, backup = true }) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error(`byteLength 非法: ${byteLength}`);
  assertMode(mode, "mode");
  assertMode(dirMode, "dirMode");
  const dir = targetFile.replace(/\/[^/]+$/, "") || ".";
  const tmpFile = `${targetFile}.tmp.$$`;
  const bakFile = backupPath(targetFile);
  let prepare;
  if (mode) {
    const keepBackup = backup ? [`if [ -f ${targetFile} ]; then bak=${bakFile} && cp -p ${targetFile} "$bak" && chmod ${mode} "$bak"; fi`] : [];
    prepare = [...keepBackup, `: > ${tmpFile}`, `chmod ${mode} ${tmpFile}`];
  } else {
    prepare = [backup
      ? `if [ -f ${targetFile} ]; then cp -p ${targetFile} ${bakFile} && cp -p ${targetFile} ${tmpFile}; fi`
      : `if [ -f ${targetFile} ]; then cp -p ${targetFile} ${tmpFile}; fi`];
  }
  const steps = [
    "umask 077",
    dirMode ? `mkdir -p ${dir} && chmod ${dirMode} ${dir}` : `mkdir -p ${dir}`,
    ...prepare,
    `cat > ${tmpFile}`,
    `[ "$(wc -c < ${tmpFile})" -eq ${byteLength} ]`,
    `mv ${tmpFile} ${targetFile}`,
  ];
  return `{ ${steps.join(" && \\\n")}; } || { rm -f ${tmpFile}; false; }`;
}
