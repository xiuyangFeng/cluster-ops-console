#!/bin/sh
# 官方 CLI 探测脚本（v2.57 第 2 期）：codex / Claude Code 的安装形态、版本、登录方式。
#
# 调用方式（本机 lib/cli/detect.mjs 组装，脚本本体经 stdin 送达）：
#   ssh <host> "env CT_CLI_IDS='codex,claude' CT_ENDPOINT_PORT='' sh -s" < cli-probe.sh
#
# 硬约束：
#   - POSIX sh，不依赖 jq / python；缺工具即该项降级为空。
#   - 脚本正文不接收插值：参数只走环境变量，并在此二次校验。
#   - 代理口令（v2.62，可选）不走环境变量：`env VAR=… sh -s` 的参数在命令行里，节点上别人用 ps 看得到。
#     本机在脚本正文前面加一行 CT_PROXY_AUTH='用户:口令'（脚本本身经标准输入送达，别人读不到），
#     连通性检查那一条 curl 再经管道把它作为配置行交给 `-K -`——口令不出现在任何进程的命令行里。
#     没有这一行（口令是关）时，下面那条 curl 与以前逐字相同。
#   - 绝不读出密钥：凭证文件只看「存在 / 有某个键 / 非密钥的类型字段」（grep -q、键名、订阅类型），
#     base URL 只输出 scheme://host:port（去掉路径、查询与 userinfo），环境变量只输出变量名。
#   - 唯一写入：版本缓存 ~/.cache/cluster-workbench/versions（tmp + mv 原子替换）。可执行文件的
#     「真实路径 + mtime + 大小」没变就直接用缓存，不再执行 `--version`（Claude 二进制约 250MB）。
#   - PATH 里找不到时只按固定清单看几个目录（ct_off_path），不启动交互 / 登录 shell（rc 文件可能打印、
#     等输入、exec 别的 shell），也不执行找到的文件。
#   - 不执行 `codex login status` / `claude auth status`（不要改回去）：前者在 API key 登录时打印 key 的首尾字符
#     （"sk-proj-***xxxxx"），密钥片段会经 SSH 回传；后者是否联网
#     无法只读确认。
#
# 输出：__CLI_BEGIN__ / __CLI_END__ 之间每行 key=value；键以 CLI id 为前缀（codex.path=…）。
# 解析与登录归类在本机 lib/cli/detect.mjs。

set -f
umask 077
PATH="$HOME/.local/bin:$PATH"
export PATH
LC_ALL=C
export LC_ALL

CT_CLI_IDS=${CT_CLI_IDS:-codex,claude}
CT_ENDPOINT_PORT=${CT_ENDPOINT_PORT:-}

ct_ids=
case "$CT_CLI_IDS" in
  *[!a-z,]*) ct_ids="codex,claude" ;;
  *) ct_ids=$CT_CLI_IDS ;;
esac
ct_port=
case "$CT_ENDPOINT_PORT" in
  "") ct_port= ;;
  *[!0-9]*) ct_port= ;;
  *) ct_port=$CT_ENDPOINT_PORT ;;
esac
# 「用户:口令」只收字母数字与一个冒号分隔的形状；别的一律当没有（它会被写进 curl 的配置行）。
ct_proxy_auth=
case "${CT_PROXY_AUTH:-}" in
  ""|*[!A-Za-z0-9:]*|*:*:*) ct_proxy_auth= ;;
  ?*:?*) ct_proxy_auth=$CT_PROXY_AUTH ;;
  *) ct_proxy_auth= ;;
esac
unset CT_PROXY_AUTH

ct_to=
if command -v timeout >/dev/null 2>&1; then ct_to="timeout 20"; fi

ct_cache_dir="$HOME/.cache/cluster-workbench"
ct_cache="$ct_cache_dir/versions"
ct_tab=$(printf '\t')

# 值净化：只留可打印字符、截到 200 字节（防止异常文件名或输出撑爆一行）。
ct_clean() {
  printf '%s' "$1" | tr -cd '[:print:]' | cut -c 1-200
}

ct_kv() {
  printf '%s=%s\n' "$1" "$(ct_clean "$2")"
}

ct_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

ct_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null
}

# 按「id + 真实路径 + mtime + 大小」查缓存；命中输出版本行。
ct_cache_get() {
  [ -f "$ct_cache" ] || return 1
  awk -F "$ct_tab" -v id="$1" -v p="$2" -v m="$3" -v s="$4" \
    '$1 == id && $2 == p && $3 == m && $4 == s { print $5; found = 1; exit } END { exit found ? 0 : 1 }' "$ct_cache" 2>/dev/null
}

# 写缓存：去掉该 id 的旧行再追加，tmp + mv 原子替换（多台电脑同时探测也不会写出半截文件）。
ct_cache_put() {
  mkdir -p "$ct_cache_dir" 2>/dev/null || return 0
  ct_tmp="$ct_cache.tmp.$$"
  {
    if [ -f "$ct_cache" ]; then awk -F "$ct_tab" -v id="$1" '$1 != id' "$ct_cache" 2>/dev/null; fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5"
  } > "$ct_tmp" 2>/dev/null && mv -f "$ct_tmp" "$ct_cache" 2>/dev/null
  rm -f "$ct_tmp" 2>/dev/null
  return 0
}

# 「装了，但非交互 SSH 的 PATH 里找不到」的候选位置：只有交互 shell（~/.bashrc / ~/.profile 里的 nvm、
# npm 前缀、conda……）才会加进 PATH 的常见安装目录，相对 $HOME 的 glob，一行一个。
# 本探测的 PATH 只有「sshd 给非交互命令的那份 + ~/.local/bin」，装在这些位置的 CLI command -v 找不到；
# 工作台的 doctor / 安装 / 登录同样经非交互 SSH 执行、同样看不到。如实报成 <id>.offPath（装在哪），
# 而不是把 PATH 问题说成「未安装」。
# codex doctor 探针（本机 lib/agents/codex.mjs）判「未安装 / 不在 PATH」用的是同一份清单：
# lib/cli/detect.mjs 的 offPathDirGlobs() 直接读下面两行标记之间的内容——改清单只改这里。
# 每行只能由字母、数字和 . _ - / * 组成（本机读取时逐行校验，不合规的整份清单作废）。
# __CT_OFF_PATH_DIRS_BEGIN__
ct_off_path_dirs='
.nvm/versions/node/*/bin
.npm-global/bin
.local/share/pnpm
.yarn/bin
.bun/bin
.volta/bin
.local/share/fnm/node-versions/*/installation/bin
.asdf/shims
miniconda3/bin
anaconda3/bin
miniforge3/bin
bin
.claude/local
'
# __CT_OFF_PATH_DIRS_END__

# 在候选位置里找 <名字> 的可执行文件：找到输出 ~/<相对路径>（清单靠前的优先，同一 glob 多个命中取第一个）。
# 子 shell 里 cd 到 $HOME 再放开通配（脚本全局 set -f），不影响外面。
ct_off_path() {
  (
    cd "$HOME" 2>/dev/null || exit 0
    set +f
    for ct_dir in $ct_off_path_dirs; do
      if [ -f "$ct_dir/$1" ] && [ -x "$ct_dir/$1" ]; then
        printf '~/%s\n' "$ct_dir/$1"
        exit 0
      fi
    done
  )
}

# 安装态与版本：command -v（PATH 已补 ~/.local/bin）→ readlink -f 真实路径 → 缓存或 --version。
ct_install() {
  ct_id=$1
  ct_cmd=$(command -v "$ct_id" 2>/dev/null)
  if [ -z "$ct_cmd" ] || [ ! -x "$ct_cmd" ]; then
    ct_kv "$ct_id.installed" 0
    ct_off=$(ct_off_path "$ct_id")
    if [ -n "$ct_off" ]; then ct_kv "$ct_id.offPath" "$ct_off"; fi
    return 0
  fi
  ct_real=$(readlink -f "$ct_cmd" 2>/dev/null)
  [ -n "$ct_real" ] || ct_real=$ct_cmd
  ct_m=$(ct_mtime "$ct_real")
  ct_s=$(ct_size "$ct_real")
  ct_kv "$ct_id.installed" 1
  ct_kv "$ct_id.command" "$ct_cmd"
  ct_kv "$ct_id.path" "$ct_real"
  ct_ver=$(ct_cache_get "$ct_id" "$ct_real" "$ct_m" "$ct_s")
  if [ -n "$ct_ver" ]; then
    ct_kv "$ct_id.versionCached" 1
  else
    ct_ver=$($ct_to "$ct_cmd" --version 2>/dev/null | head -n 1)
    ct_ver=$(ct_clean "$ct_ver")
    ct_kv "$ct_id.versionCached" 0
    # 取不到版本（超时 / 坏包）不写缓存，下一轮再试。
    if [ -n "$ct_ver" ] && [ -n "$ct_m" ]; then ct_cache_put "$ct_id" "$ct_real" "$ct_m" "$ct_s" "$ct_ver"; fi
  fi
  ct_kv "$ct_id.version" "$ct_ver"
}

# npm 全局安装是否并存（只看常见位置，不执行 npm）。
ct_npm_global() {
  ct_pkg=$1
  for ct_root in "$HOME/.local/lib/node_modules" "$HOME/.npm-global/lib/node_modules" \
    "/usr/local/lib/node_modules" "/usr/lib/node_modules"; do
    if [ -d "$ct_root/$ct_pkg" ]; then echo 1; return 0; fi
  done
  echo 0
}

# 受管 keys/*.env 里导出的变量名（只取名字）。
ct_key_names() {
  cat "$HOME"/.config/cluster-workbench/keys/*.env 2>/dev/null \
    | sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' \
    | sort -u | head -n 20 | tr '\n' ',' | sed 's/,$//'
}

ct_codex() {
  ct_install codex
  ct_kv codex.npmGlobal "$(ct_npm_global @openai/codex)"
  ct_home=${CODEX_HOME:-$HOME/.codex}
  ct_auth="$ct_home/auth.json"
  if [ -s "$ct_auth" ]; then
    ct_kv codex.authFile 1
    if grep -q '"refresh_token"[[:space:]]*:[[:space:]]*"' "$ct_auth" 2>/dev/null; then ct_kv codex.authTokens 1; else ct_kv codex.authTokens 0; fi
    if grep -q '"OPENAI_API_KEY"[[:space:]]*:[[:space:]]*"' "$ct_auth" 2>/dev/null; then ct_kv codex.authApiKey 1; else ct_kv codex.authApiKey 0; fi
    ct_kv codex.authMode "$(sed -n -E 's/.*"auth_mode"[[:space:]]*:[[:space:]]*"([A-Za-z_]+)".*/\1/p' "$ct_auth" 2>/dev/null | head -n 1)"
  else
    ct_kv codex.authFile 0
  fi
  # config.toml：顶层 model_provider / 凭证存放方式，以及所选 provider 段的 base_url（只留源）与 env_key 名。
  ct_toml="$ct_home/config.toml"
  if [ -f "$ct_toml" ]; then
    awk '
      function val(s) { sub(/^[^=]*=[[:space:]]*/, "", s); sub(/[[:space:]]*(#.*)?$/, "", s); gsub(/^"|"$/, "", s); return s }
      function origin(u,   head, rest) {
        if (!match(u, /^[A-Za-z][A-Za-z0-9+.-]*:\/\//)) return ""
        head = substr(u, 1, RLENGTH); rest = substr(u, RLENGTH + 1)
        sub(/[\/?#].*$/, "", rest); sub(/^.*@/, "", rest)
        return head rest
      }
      /^[[:space:]]*\[/ { sec = $0; sub(/^[[:space:]]*\[+[[:space:]]*/, "", sec); sub(/[[:space:]]*\]+.*$/, "", sec); gsub(/"/, "", sec); next }
      /^[[:space:]]*[A-Za-z_]+[[:space:]]*=/ {
        key = $0; sub(/^[[:space:]]*/, "", key); sub(/[[:space:]]*=.*$/, "", key)
        if (sec == "") top[key] = val($0)
        else if (index(sec, "model_providers.") == 1) { p = substr(sec, 17); pv[p SUBSEP key] = val($0) }
      }
      END {
        mp = top["model_provider"]
        print "codex.provider=" mp
        print "codex.credStore=" top["cli_auth_credentials_store"]
        print "codex.forcedLogin=" top["forced_login_method"]
        if (mp != "") {
          print "codex.providerBaseUrl=" origin(pv[mp SUBSEP "base_url"])
          print "codex.providerEnvKey=" pv[mp SUBSEP "env_key"]
        }
      }
    ' "$ct_toml" 2>/dev/null | tr -cd '[:print:]\n' | grep -E '^codex\.[A-Za-z]+=[A-Za-z0-9_.:/+-]*$' | cut -c 1-200
  fi
}

ct_claude() {
  ct_install claude
  ct_kv claude.npmGlobal "$(ct_npm_global @anthropic-ai/claude-code)"
  ct_cred="$HOME/.claude/.credentials.json"
  if [ -s "$ct_cred" ] && grep -q '"claudeAiOauth"' "$ct_cred" 2>/dev/null && grep -q '"accessToken"' "$ct_cred" 2>/dev/null; then
    ct_kv claude.oauth 1
    ct_kv claude.subscription "$(sed -n -E 's/.*"subscriptionType"[[:space:]]*:[[:space:]]*"([A-Za-z_]+)".*/\1/p' "$ct_cred" 2>/dev/null | head -n 1)"
  else
    ct_kv claude.oauth 0
  fi
  ct_settings="$HOME/.claude/settings.json"
  if [ -f "$ct_settings" ]; then
    ct_kv claude.settingsEnv "$(grep -o -E '"(ANTHROPIC_[A-Z_]+|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z]+)"[[:space:]]*:' "$ct_settings" 2>/dev/null \
      | sed -E 's/^"([A-Z_]+)".*/\1/' | sort -u | tr '\n' ',' | sed 's/,$//')"
    ct_kv claude.baseUrl "$(sed -n -E 's/.*"ANTHROPIC_BASE_URL"[[:space:]]*:[[:space:]]*"([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\/"@?#]*@)?([^\/"?#]*).*/\1\3/p' "$ct_settings" 2>/dev/null | head -n 1)"
    if grep -q '"apiKeyHelper"[[:space:]]*:' "$ct_settings" 2>/dev/null; then ct_kv claude.apiKeyHelper 1; else ct_kv claude.apiKeyHelper 0; fi
    # reclaude 接管：settings.json 的 env 指向 ~/.reclaude/ 下的 CA（它以本机 MITM 代理转发 Claude 流量）。
    if grep -q '\.reclaude/' "$ct_settings" 2>/dev/null; then ct_kv claude.reclaude 1; else ct_kv claude.reclaude 0; fi
  fi
  if [ -f "$HOME/.claude.json" ] && grep -q '"primaryApiKey"[[:space:]]*:[[:space:]]*"' "$HOME/.claude.json" 2>/dev/null; then
    ct_kv claude.primaryApiKey 1
  else
    ct_kv claude.primaryApiKey 0
  fi
}

echo __CLI_BEGIN__
ct_kv user "$(id -un 2>/dev/null)"
ct_kv keys.env "$(ct_key_names)"
# 逗号换空格再按默认 IFS 切分：探测函数里的 `$ct_to "$ct_cmd"` 依赖默认 IFS 把 "timeout 20" 拆成两个词，
# 循环期间不能把 IFS 改成逗号。
for ct_one in $(printf '%s' "$ct_ids" | tr ',' ' '); do
  case "$ct_one" in
    codex) ct_codex ;;
    claude) ct_claude ;;
    *) ;;
  esac
done
# 连通性（Claude Code 适配器用）：经本人反向端口 CONNECT api.anthropic.com，401/403/404/405 也算到达。
if [ -n "$ct_port" ] && [ -n "$ct_proxy_auth" ]; then
  # printf 是 shell 内建（不产生带参数的新进程），口令经管道进 curl 的标准输入。
  ct_kv endpoint "$(printf 'proxy-user = "%s"\n' "$ct_proxy_auth" | curl -s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 10 --max-time 15 \
    -x "http://127.0.0.1:$ct_port" -K - https://api.anthropic.com/v1/models 2>/dev/null)"
elif [ -n "$ct_port" ]; then
  ct_kv endpoint "$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 10 --max-time 15 \
    -x "http://127.0.0.1:$ct_port" https://api.anthropic.com/v1/models 2>/dev/null)"
fi
echo __CLI_END__
exit 0
