// 撤销接入之前的只读查看：集群上现在有哪些受管内容。界面的预览靠它逐条说清「会改哪些文件、恢复什么、删什么」。
//
// 只读——不建文件、不改任何东西。真正的撤销命令仍全部来自 cluster-env.mjs 的 buildUndoCommands；这里的判定
// 与那几条命令逐条用同一个口径（同一个标记行、同一个停用前缀、同一批启动文件、同一个受管目录），
// 所以这里看到什么，撤销就会动什么：
//   BLOCK<TAB>文件                  这个启动文件里有引入块（strip-source-blocks 会删）
//   STRAY<TAB>文件<TAB>行号<TAB>整行  行首是停用前缀的行（restore-strays 会去掉前缀、恢复原样）
//   ENV=1|0                          受管 env.sh 在不在（remove-env 会删）
//   KEY<TAB>文件名                   keys/ 里的文件（remove-env 连目录一起删；只列名字，不读内容）
//   __CWB_UNDO_SURVEY_DONE__         哨兵：区分"查完了、确实没有"与"SSH 中途断了"
// 纯函数：命令生成与输出解析。没有任何插值来自用户输入，全是本仓库的常量。
import { CLUSTER_ENV_DIR, CLUSTER_ENV_KEYS_DIR, CLUSTER_ENV_MARKER, CLUSTER_ENV_PATH, SHELL_RC_FILES, STRAY_DISABLED_PREFIX } from "../cluster-env.mjs";
import { markerLines } from "../shell/remote-file.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export const UNDO_SURVEY_DONE = "__CWB_UNDO_SURVEY_DONE__";

// 解析时每类最多收这么多条：输出来自远端，不能让一个塞满垃圾的文件把内存撑大。
const MAX_ITEMS = 200;
const MAX_TEXT = 400;

export function buildUndoSurveyCommand() {
  const { begin } = markerLines(CLUSTER_ENV_MARKER);
  const keysDir = `${CLUSTER_ENV_DIR}/${CLUSTER_ENV_KEYS_DIR}`;
  return wrapSh([
    'cd "$HOME" || exit 1',
    `for f in ${SHELL_RC_FILES.join(" ")}; do`,
    '  if [ -f "$f" ]; then',
    `    if grep -qxF "${begin}" "$f"; then printf 'BLOCK\\t%s\\n' "$f"; fi`,
    // index() 是按字面找子串、== 1 即"行首正好是这个前缀"：与撤销命令里 sed 的 ^前缀 同一个判定，不用再转义一遍正则。
    `    awk -v p="${STRAY_DISABLED_PREFIX}" 'index($0, p) == 1 { printf "STRAY\\t%s\\t%d\\t%s\\n", FILENAME, FNR, $0 }' "$f"`,
    "  fi",
    "done",
    `if [ -f ${CLUSTER_ENV_PATH} ]; then echo ENV=1; else echo ENV=0; fi`,
    `if [ -d ${keysDir} ]; then ls -1A ${keysDir} | while IFS= read -r k; do printf 'KEY\\t%s\\n' "$k"; done; fi`,
    `echo ${UNDO_SURVEY_DONE}`,
  ]);
}

const rcFile = (name) => (SHELL_RC_FILES.includes(name) ? name : null);

// → { blocks: [文件], strays: [{ file, line, text }], envFile, keys: [文件名] } | null（没看到哨兵：SSH 没到远端或输出被截断）。
// 文件只认 SHELL_RC_FILES 白名单；strays 的 text 是去掉停用前缀之后的原行（也就是恢复后的样子）。
// 哨兵前后若有 rc 文件打印的杂音一并忽略。
export function parseUndoSurvey(stdout) {
  const text = String(stdout ?? "");
  if (!new RegExp(`^${UNDO_SURVEY_DONE}\\r?$`, "m").test(text)) return null;
  const blocks = [];
  const strays = [];
  const keys = [];
  let envFile = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "ENV=1") {
      envFile = true;
    } else if (raw.startsWith("BLOCK\t")) {
      const file = rcFile(raw.slice("BLOCK\t".length));
      if (file && !blocks.includes(file)) blocks.push(file);
    } else if (raw.startsWith("STRAY\t")) {
      const [, fileRaw, lineRaw, ...rest] = raw.split("\t");
      const file = rcFile(fileRaw);
      const line = Number(lineRaw);
      const original = rest.join("\t");
      if (!file || !Number.isSafeInteger(line) || line <= 0 || !original.startsWith(STRAY_DISABLED_PREFIX)) continue;
      if (strays.length < MAX_ITEMS) strays.push({ file, line, text: original.slice(STRAY_DISABLED_PREFIX.length).slice(0, MAX_TEXT) });
    } else if (raw.startsWith("KEY\t")) {
      const name = raw.slice("KEY\t".length).slice(0, MAX_TEXT);
      if (name && keys.length < MAX_ITEMS && !keys.includes(name)) keys.push(name);
    }
  }
  return { blocks, strays, envFile, keys };
}
