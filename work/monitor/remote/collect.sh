#!/bin/sh
# 零残留远端采集脚本（v2.18）
# 设计：docs/superpowers/specs/2026-09-02-multi-tunnel-team-hub-design.md §6.4
#
# 调用方式（本机 lib/collector.mjs 组装，脚本本体经 stdin 送达，远端不落文件）：
#   ssh <host> "env CT_PROFILE='slow' CT_PORTS='7891' sh -s" < collect.sh
#
# 硬约束：
#   - POSIX sh（远端登录 shell 是 bash 5.0，但本脚本不得依赖 bash 特性）；
#     不依赖 jq / python / 任何非默认工具，缺失即该段降级为空。
#   - 脚本正文不接收任何插值：全部参数走环境变量，且在此处二次校验（本机已校验一遍，
#     这里是纵深防御——远端拿到什么都不信）。
#   - 每段独立 `2>/dev/null || true` 且自带 head -c 上限；任何一段失败/超长都不影响其它段。
#   - 只读：脚本不在远端创建或写入任何文件。
#
# 输出格式：每段由独占一行的 `__CT_BEGIN <name>__` / `__CT_END <name>__` 包裹。
# 段名固定：sys cpu-stat filesystem gpu agents ports proc-top tunnel-egress slurm reclaude-state reclaude-logs。
#   fast → reclaude-logs reclaude-state ports
#   slow → sys cpu-stat filesystem gpu agents ports proc-top tunnel-egress slurm（slurm 恒在最后：体量最大，
#          放最后才不会挤占其它段的总上限）

# 不用 set -e：任何一段失败都必须继续走完其余段。
# set -f 关掉路径展开：CT_PORTS 的 IFS 切分是不带引号的 $var 展开，
# 关掉 glob 后即使值里混进 * ? [ 也不会触发文件名展开。
set -f

CT_PROFILE=${CT_PROFILE:-}
CT_PORTS=${CT_PORTS:-}
CT_FS_ROOT=${CT_FS_ROOT:-}

CT_TOTAL_CAP=131072  # 全部段正文合计上限 128KB（各段自带上限后本值几乎不会触发，兜底用）
                     # v2.76 起 gpu 段带上逐进程命令行（每段 20KB），各段上限之和仍小于本值
ct_used=0

# ---------------------------------------------------------------------------
# 参数二次校验：不合法即关闭对应功能，并在对应段输出 skip:<reason>。
# ---------------------------------------------------------------------------

# CT_PROFILE 决定段集合本身，没有"对应段"可写 skip，因此非法值回落到更轻的 fast。
ct_profile=fast
case "$CT_PROFILE" in
  fast) ct_profile=fast ;;
  slow) ct_profile=slow ;;
  *) ct_profile=fast ;;
esac

# CT_PORTS：只允许数字与逗号。
ct_ports=
ct_ports_skip=
case "$CT_PORTS" in
  "") ct_ports_skip="skip:no-ports" ;;
  *[!0-9,]*) ct_ports_skip="skip:bad-ports" ;;
  *) ct_ports=$CT_PORTS ;;
esac

# CT_FS_ROOT：只给测试用——读 /proc 与 /sys/fs/cgroup 时加在前面的目录（夹具里的假文件系统）。
# 本机的调用从不设置它；值不是「/ 开头、只含字母数字 / . _ -」的绝对路径就当没给，照读真实路径。
ct_root=
case "$CT_FS_ROOT" in
  ""|*[!A-Za-z0-9/._-]*) ;;
  /*) ct_root=$CT_FS_ROOT ;;
esac

# ---------------------------------------------------------------------------
# 段输出helper：正文经命令替换归一（尾部换行被剥掉），因此 __CT_END 永远独占一行，
# 本机解析器"整行精确等于 marker 才认"的规则才成立。
# ---------------------------------------------------------------------------
ct_emit() {
  ct_name=$1
  ct_body=$2
  ct_left=$((CT_TOTAL_CAP - ct_used))
  if [ "$ct_left" -le 0 ]; then
    ct_body=
  elif [ ${#ct_body} -gt "$ct_left" ]; then
    ct_body=$(printf '%s' "$ct_body" | head -c "$ct_left" 2>/dev/null)
  fi
  ct_used=$((ct_used + ${#ct_body}))
  printf '__CT_BEGIN %s__\n' "$ct_name"
  if [ -n "$ct_body" ]; then
    printf '%s\n' "$ct_body"
  fi
  printf '__CT_END %s__\n' "$ct_name"
}

# ct_job_of <pid>：把这个进程所在的 Slurm 作业号放进 ct_job；不在作业里、读不到、没有 cgroup → 空。
# 依据是 /proc/<pid>/cgroup（对所有账号可读）里从层级根开始的路径，只认两种形状：
#   cgroup v1  <n>:<控制器>:/slurm/uid_<uid>/job_<id>/…（本集群实测；一机多 slurmd 时目录叫 slurm_<节点名>）
#   cgroup v2  0::/system.slice/[<节点名>_]slurmstepd.scope/job_<id>/…
# 必须从根开始：用户在自己 user.slice 下面建的同名目录不算。非作业进程是 /user.slice/…、/system.slice/…。
# 全程 shell 内建命令，不起子进程；调用前 pid 已校验为纯数字。
ct_job_of() {
  ct_job=
  [ -r "$ct_root/proc/$1/cgroup" ] || return 0
  while IFS= read -r ct_cg_line; do
    # 行形如 <层级号>:<控制器列表>:<路径>；前两段都不含冒号，剥两次就是路径。
    ct_cg_path=${ct_cg_line#*:}
    ct_cg_path=${ct_cg_path#*:}
    case "$ct_cg_path" in
      /slurm/uid_[0-9]*/job_[0-9]*|/slurm_*/uid_[0-9]*/job_[0-9]*|/system.slice/*slurmstepd.scope/job_[0-9]*)
        ct_job=${ct_cg_path#*/job_}
        ct_job=${ct_job%%/*}
        break
        ;;
    esac
  done < "$ct_root/proc/$1/cgroup"
  case "$ct_job" in
    *[!0-9]*) ct_job= ;;
  esac
  return 0
}

# ct_proc_of <pid>：把这个进程的属主 / 已运行秒数 / 命令行放进 ct_pf_user / ct_pf_etimes / ct_pf_cmd（v2.76）。
# 一次 ps 取三列，fork 数与 v2.75 的 user+comm 两列调用相同。两处兜底，都是为了别把整行丢掉：
#   - ps 什么都没输出（进程刚退出）→ 再按「属主 + 命令行」两列试一次，秒数留空；
#   - 第 2 列不是纯数字（老 ps 不认 etimes，把它跳过或换了写法）→ 秒数记未知，
#     这一列算作命令行的第一个词，不把命令行的开头当成时长。
# 命令行单条截断 200 字节：一条超长命令行不能把整段的预算吃掉。全程只 fork ps 与 head。
ct_proc_of() {
  # 先把 pid 收进变量：`set --` 在命令替换为空时会把位置参数清空，后面再写 "$1" 就是空串
  # （第一版就栽在这儿：回退那次调用变成了 ps -p ''，属主与命令行全空）。
  ct_pf_pid=$1
  ct_pf_user= ct_pf_etimes= ct_pf_cmd=
  set -- $(ps -o user:32=,etimes=,args= -p "$ct_pf_pid" 2>/dev/null)
  if [ $# -eq 0 ]; then
    set -- $(ps -o user:32=,args= -p "$ct_pf_pid" 2>/dev/null)
  fi
  ct_pf_user=${1:-}
  if [ $# -ge 2 ]; then
    shift
    case "$1" in
      ""|*[!0-9]*) ;;
      *)
        ct_pf_etimes=$1
        if [ $# -ge 2 ]; then shift; fi
        ;;
    esac
    ct_pf_cmd=$*
    if [ -n "$ct_pf_cmd" ]; then
      ct_pf_cmd=$(printf '%s' "$ct_pf_cmd" | head -c 200)
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 各段正文。
# ---------------------------------------------------------------------------

# sys：与 probes.mjs 的 primary-remote / load:* 远端命令逐字同形
# （hostname; uptime; free -h | sed -n '1,2p'; df -h "$HOME" | tail -1; nproc → "nproc: N"），
# 保证 monitor-core.parseRemoteProbeOutput 与前端 load-panel.parseRemoteLoad 零改动可解析。
# 顺序不可动：parseRemoteProbeOutput 按「首个含 % 的非 Mem 行」定位磁盘行，nproc 必须在 df 之后。
ct_sys() {
  {
    hostname
    uptime
    free -h 2>/dev/null | sed -n '1,2p'
    df -h "$HOME" 2>/dev/null | tail -1
    nproc 2>/dev/null | sed 's/^/nproc: /'
  } 2>/dev/null | head -c 8192
}

# cpu-stat（T03，仅 slow）：/proc/stat 聚合 CPU 计数 + boot_id。真利用率由本机用
# 相邻两轮 slow 样本差分计算，远端不 sleep 等第二帧。LC_ALL=C 稳定数字格式；
# /proc/stat 不可读（非 Linux / 容器裁剪）时输出 cpu=unknown，段仍存在。
# guest/guest_nice 已包含在 user/nice 里，本机差分公式不再重复相加。
ct_cpu_stat() {
  ct_cpu_line=$(LC_ALL=C sed -n '1p' /proc/stat 2>/dev/null | tr -s ' \t' ' ' | sed 's/^ //;s/ $//')
  case "$ct_cpu_line" in
    "cpu "*) printf 'cpu=%s\n' "$(printf '%s' "$ct_cpu_line" | sed 's/^cpu //')" ;;
    *) printf 'cpu=unknown\n' ;;
  esac
  ct_boot=$(LC_ALL=C tr -d '\n' < /proc/sys/kernel/random/boot_id 2>/dev/null)
  case "$ct_boot" in
    "" ) printf 'boot_id=unknown\n' ;;
    *[!0-9a-f-]*) printf 'boot_id=unknown\n' ;;
    *) printf 'boot_id=%s\n' "$ct_boot" ;;
  esac
}

# filesystem（T03，仅 slow）：$HOME 所在挂载点的字节用量与 inode 信息。
# df -P -k 是 1K 块口径（POSIX 保证单行、挂载点内空格转义为 \040）；capacity 保留
# df 的可用空间口径原值，不做 used/total 除法换算（保留块等原因口径可能不同）。
# 只读 $HOME 一个路径，不做递归 du。
ct_filesystem() {
  ct_fs_line=$(LC_ALL=C df -P -k "$HOME" 2>/dev/null | tail -n 1 | tr -s ' \t' ' ' | sed 's/^ //;s/ $//')
  if [ -z "$ct_fs_line" ]; then
    printf 'state=unavailable\n'
    return 0
  fi
  printf 'state=ok\n'
  # 字段：device total_kb used_kb avail_kb capacity% mount...
  ct_fs_head=$(printf '%s' "$ct_fs_line" | awk '{ print $1, $2, $3, $4, $5 }')
  ct_fs_mount=$(printf '%s' "$ct_fs_line" | awk '{ $1=$2=$3=$4=$5=""; sub(/^ +/, ""); print }')
  printf '%s\n' "$ct_fs_head" | {
    IFS=' ' read -r ct_fs_dev ct_fs_total ct_fs_used ct_fs_avail ct_fs_cap
    # df 的容量列形如 "86%"：剥掉 % 后再校验纯数字，畸形置空（本机解析端回落 null）。
    ct_fs_cap=$(printf '%s' "$ct_fs_cap" | tr -d '%')
    case "$ct_fs_cap" in
      *[!0-9]*) ct_fs_cap="" ;;
    esac
    printf 'device=%s\n' "$ct_fs_dev"
    printf 'total_kb=%s\n' "$ct_fs_total"
    printf 'used_kb=%s\n' "$ct_fs_used"
    printf 'avail_kb=%s\n' "$ct_fs_avail"
    printf 'capacity_pct=%s\n' "$ct_fs_cap"
  }
  printf 'mount=%s\n' "$ct_fs_mount"
  ct_fs_i=$(LC_ALL=C df -P -i "$HOME" 2>/dev/null | tail -n 1 | tr -s ' \t' ' ' | sed 's/^ //;s/ $//')
  printf '%s' "$ct_fs_i" | {
    # 字段：device inodes iused ifree iuse% mount——首列是设备名，必须先跳过
    #（曾少读这一列，整体错位一格，把 IFree 当成 IUse% 报出「inode 506172879%」）。
    IFS=' ' read -r _i_dev _i_total _i_used _i_free _i_pct _
    _i_pct=$(printf '%s' "$_i_pct" | tr -d '%')
    case "$_i_pct" in
      *[!0-9]*) _i_pct="" ;;
    esac
    # 百分比只可能是 0–100：超出即视为解析错位，置空（本机解析端回落 null）。
    if [ -n "$_i_pct" ] && [ "$_i_pct" -gt 100 ]; then _i_pct=""; fi
    case "$_i_total" in
      *[!0-9]*) _i_total="" ;;
    esac
    case "$_i_used" in
      *[!0-9]*) _i_used="" ;;
    esac
    printf 'inodes_total=%s\n' "$_i_total"
    printf 'inodes_used=%s\n' "$_i_used"
    printf 'inode_pct=%s\n' "$_i_pct"
  }
}

# gpu：每张卡一行
#   gpu=<index>, <uuid>, <名称>, <显存已用 MiB>, <显存总量 MiB>, <利用率 %>, <温度 °C>, <功耗 W>
# 随后是占用进程（每个计算进程一行，最多 64 行）
#   gpuproc=<uuid>|<pid>|<显存 MiB>|<属主>|<已运行秒数>|<Slurm 作业号>|<命令行>
# 与直连节点（ct_hop_script）同一格式，本机由 lib/gpu-cards.mjs 解析。无 nvidia-smi（非 GPU
# 机器 / 腾讯云）时输出空段。温度 / 功耗在不支持的卡上是 [N/A]；老驱动不认这两个字段时整条
# 查询会失败，退回基础字段并把这两项留空（行尾补 ", , "，段数不变）。
# 前 6 段（uuid / pid / 显存 / 属主 / 已运行秒数 / 作业号）都不含 |，命令行是第 7 段起的自由文本——
# 就算命令行里有 | 也不影响本机解析（它按前 6 段切、其余整段算命令行）。
# 命令行 = ps 的 args（v2.76）：谁在用 nvidia-smi 看不见的那部分（python / jupyter / 容器）看这个。
# 进程名不再单独取：本机只用它剔除 nvidia-cuda-mps 守护进程，从命令行第一个词的 basename 推。
# ps 取不到（进程刚退出）时属主、秒数、命令行留空，行仍然发出，本机记成「未知」占用者；
# 老 ps 不认 etimes 时退回「属主 + 命令行」两列，秒数留空，属主与命令行照旧拿得到。
# 作业号（v2.62）取自进程的 cgroup（见 ct_job_of），不在作业里 / 取不到时留空——空 = 不经 Slurm。
ct_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  ct_gpu_rows=$(nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw \
    --format=csv,noheader,nounits 2>/dev/null | head -n 16)
  if [ -z "$ct_gpu_rows" ]; then
    ct_gpu_rows=$(nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu \
      --format=csv,noheader,nounits 2>/dev/null | head -n 16 | sed 's/$/, , /')
  fi
  [ -n "$ct_gpu_rows" ] || return 0
  {
    printf '%s\n' "$ct_gpu_rows" | sed 's/^/gpu=/'
    nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null | head -n 64 \
      | while IFS=', ' read -r ct_ga_uuid ct_ga_pid ct_ga_mem; do
          case "$ct_ga_pid" in ""|*[!0-9]*) continue ;; esac
          # 属主 / 已运行秒数 / 命令行（见 ct_proc_of），Slurm 作业号（见 ct_job_of）
          ct_proc_of "$ct_ga_pid"
          ct_job_of "$ct_ga_pid"
          printf 'gpuproc=%s|%s|%s|%s|%s|%s|%s\n' "$ct_ga_uuid" "$ct_ga_pid" "$ct_ga_mem" "$ct_pf_user" "$ct_pf_etimes" "$ct_job" "$ct_pf_cmd"
        done
  } | head -c 20480
}

# ports：ss -ltn（缺失回退 netstat -ltn）中命中 CT_PORTS 白名单的监听行。
# 反向端口的监听态对所有用户可见，因此判定本机隧道是否落地不需要额外权限。
ct_ports_section() {
  if [ -z "$ct_ports" ]; then
    printf '%s\n' "$ct_ports_skip"
    return 0
  fi
  ct_listing=$({ ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null; } || true)
  [ -n "$ct_listing" ] || return 0
  # 端口号后必须紧跟空白或行尾，避免 :789 命中 :7891。$ 由单引号变量携带，
  # 不写进双引号串（免得被误读成参数展开）。
  ct_tail='([[:space:]]|$)'
  ct_oldifs=$IFS
  IFS=,
  for ct_p in $ct_ports; do
    [ -n "$ct_p" ] || continue
    printf '%s\n' "$ct_listing" | grep -E ":${ct_p}${ct_tail}" 2>/dev/null || true
  done
  IFS=$ct_oldifs
}

# agents：本机各 Agent 的安装态与 reclaude 服务活性，key=value 每行一条。
# claude（v2.57）= 官方 Claude Code 可执行文件在（原生安装落在 ~/.local/bin/claude；非交互 PATH 不含该目录）。
# 版本 / 安装形态 / 登录方式不在这里采集（本脚本不落文件、不缓存）：见 cli:<serverId> 探针（remote/cli-probe.sh）。
ct_agents() {
  ct_codex=0
  if command -v codex >/dev/null 2>&1 || [ -e "$HOME/.local/bin/codex" ]; then ct_codex=1; fi
  ct_claude=0
  if command -v claude >/dev/null 2>&1 || [ -e "$HOME/.local/bin/claude" ]; then ct_claude=1; fi
  ct_reclaude=0
  if command -v reclaude >/dev/null 2>&1 || [ -e "$HOME/.local/bin/reclaude" ]; then ct_reclaude=1; fi
  ct_zcode=0
  if [ -e "$HOME/.zcode/server/zcode-server.cjs" ]; then ct_zcode=1; fi
  ct_active=$(systemctl --user is-active reclaude 2>/dev/null | head -n 1)
  case "$ct_active" in
    active) ct_active=active ;;
    "") ct_active=unknown ;;
    *) ct_active=inactive ;;
  esac
  printf 'codex=%s\n' "$ct_codex"
  printf 'claude=%s\n' "$ct_claude"
  printf 'reclaude=%s\n' "$ct_reclaude"
  printf 'zcode=%s\n' "$ct_zcode"
  printf 'reclaudeActive=%s\n' "$ct_active"
  printf 'user=%s\n' "$(id -un 2>/dev/null)"
  printf 'hostname=%s\n' "$(hostname 2>/dev/null)"
}

# proc-top（v2.62，仅 slow）：这台机器的占用现场——谁在用 CPU 与内存、是不是 Slurm 作业。
# 登录节点同时是计算节点，还有人不经 Slurm 直接在上面跑；负载或内存高的时候要说得出是谁。
# 做法：一次 ps 列出全部进程（pid / 属主 / %CPU / 常驻内存 KB），取 %CPU 最高的 28 个与常驻内存
# 最高的 12 个（去重后至多 40 个），逐个看 cgroup 在不在 Slurm 作业里（ct_job_of，不起子进程），
# 再按账号汇总。只输出账号名与汇总数字，不取任何进程的命令行。
#   sampled=<参与汇总的进程数>
#   slurm=1|0   这台机器上有没有 Slurm 的 cgroup 层级。0 = 分不出作业内外（没有 Slurm、没用 cgroup
#               跟踪进程、或开机后还没跑过作业）：数字全记在「作业外」那几栏，本机不据此说「不经 Slurm」
#   top=<账号>|<作业内 %CPU>|<作业外 %CPU>|<作业内常驻内存 KB>|<作业外常驻内存 KB>|<作业内进程数>|<作业外进程数>
# top= 最多 6 行：%CPU 合计最高的 4 个账号，再加其余账号里常驻内存合计最高的 2 个。
# 口径：ps 的 %CPU 是进程启动以来的平均值（CPU 时间 / 运行时长），不是这一刻的瞬时值，100 = 一个核；
# 汇总只覆盖取到的这几十个进程，不是全部进程的合计。
# 开销：每轮多 1 次 ps（列全部进程）、几个文本管道（sort / head / awk）与至多 40 次读 cgroup 文件；
# 有 coreutils timeout 时 ps 最多等 3s。ps 不认这些选项（BusyBox / macOS）、超时或没有输出 → 空段，
# 其余段不受影响。
ct_proc_top() (
  LC_ALL=C
  export LC_ALL
  ct_pt_to=
  if command -v timeout >/dev/null 2>&1; then ct_pt_to="timeout 3"; fi
  ct_pt_all=$($ct_pt_to ps -eo pid=,user:32=,pcpu=,rss= 2>/dev/null) || return 0
  [ -n "$ct_pt_all" ] || return 0
  ct_pt_pick=$({
    printf '%s\n' "$ct_pt_all" | sort -k3,3nr | head -n 28
    printf '%s\n' "$ct_pt_all" | sort -k4,4nr | head -n 12
  } 2>/dev/null | awk '$1 ~ /^[0-9]+$/ && !seen[$1]++')
  [ -n "$ct_pt_pick" ] || return 0
  # cgroup v1 下 Slurm 的层级目录是 <控制器>/slurm（proctrack 用 freezer，task/cgroup 用其余几个），
  # v2 是 system.slice/slurmstepd.scope；首个作业步启动时创建，之后一直在。
  ct_pt_slurm=0
  for ct_pt_ctl in freezer cpuset memory devices; do
    if [ -d "$ct_root/sys/fs/cgroup/$ct_pt_ctl/slurm" ]; then ct_pt_slurm=1; fi
  done
  if [ -d "$ct_root/sys/fs/cgroup/system.slice/slurmstepd.scope" ]; then ct_pt_slurm=1; fi
  printf '%s\n' "$ct_pt_pick" | while read -r ct_pt_pid ct_pt_user ct_pt_cpu ct_pt_rss ct_pt_rest; do
    case "$ct_pt_pid" in ""|*[!0-9]*) continue ;; esac
    # ps 之后已经退出的进程不计：读不到它的 cgroup，算进「作业外」会把刚结束的作业进程说成不经 Slurm。
    [ -d "$ct_root/proc/$ct_pt_pid" ] || continue
    ct_job_of "$ct_pt_pid"
    ct_pt_in=0
    if [ -n "$ct_job" ]; then ct_pt_in=1; fi
    printf '%s %s %s %s\n' "$ct_pt_user" "$ct_pt_in" "$ct_pt_cpu" "$ct_pt_rss"
  done | awk -v slurm="$ct_pt_slurm" '
    $1 ~ /^[A-Za-z0-9._-]+$/ && $3 ~ /^[0-9]+\.?[0-9]*$/ && $4 ~ /^[0-9]+$/ {
      u = $1
      if (!(u in known)) { known[u] = 1; order[++n] = u }
      if ($2 == 1) { cj[u] += $3; rj[u] += $4; nj[u]++ } else { co[u] += $3; ro[u] += $4; no[u]++ }
      total++
    }
    END {
      if (!total) exit
      printf "sampled=%d\n", total
      printf "slurm=%d\n", slurm
      for (k = 1; k <= 6; k++) {
        best = ""
        for (i = 1; i <= n; i++) {
          u = order[i]
          if (u in picked) continue
          v = (k <= 4) ? cj[u] + co[u] : rj[u] + ro[u]
          if (best == "" || v > bv) { best = u; bv = v }
        }
        if (best == "") break
        picked[best] = 1
        printf "top=%s|%.1f|%.1f|%d|%d|%d|%d\n", best, cj[best], co[best], rj[best], ro[best], nj[best], no[best]
      }
    }'
)

# tunnel-egress（仅 slow）：此刻经反向隧道出网的程序——这台机器上连着 127.0.0.1:<反向端口> 的 TCP 连接，
# 按程序名汇总连接数与这些连接上已收发的字节。集群上的 CLI 用 HTTP_PROXY=http://127.0.0.1:<反向端口> 出网，
# 连着这个端口的就是此刻在经隧道出网的程序。
# 端口取 CT_PORTS 的第一个（本机只传这台服务器自己的 remotePort）：上面已校验为纯数字，这里再卡 1–65535。
# 做法：一次 ss -tnpi state established '( dport = :<端口> )'，只认对端是回环地址（127.x / ::1 / ::ffff:127.x）的行。
#   - 非 root 的 ss -p 只给本账号的进程标出程序名；别的账号的连接没有 users:((…))，记进 others（看不到是谁）。
#   - -i 的 bytes_acked（发出并被确认；老内核没有时退回 bytes_sent）/ bytes_received 是这条连接建立以来的累计，
#     只覆盖此刻还开着的连接；内核不给就输出 -（本机解析成 null）。
#   - ss 不认 -p / -i（非零退出）→ 退回 ss -tn，只数连接（detail=basic）；也失败 / 超时 → state=error；
#     没有 ss → state=absent。
# 输出（汇总在前，段被截断时只丢尾部的程序行）：
#   state=ok|absent|error|skip:<原因>   port=<端口>   detail=full|basic
#   total=<连接数>|<发送字节|->|<接收字节|->
#   others=<连接数>|<发送字节|->|<接收字节|->     （只在 detail=full 时有）
#   progs=<程序个数>
#   prog=<程序名>|<连接数>|<发送字节|->|<接收字节|->   按连接数、再按接收字节从大到小，最多 20 行
# 程序名是 ss 报的进程名（内核 comm，≤15 字节）：白名单外的字符换成 _、截到 32 字节；不取 pid、命令行与本地地址。
# 有 coreutils timeout 时 ss 最多等 3s（超时不再跑回退）；ss 输出最多读 20000 行。只读：不建立任何连接。
# 数字用 %.0f 输出：老 mawk 的 %d 超过 2^31 会溢出，字节数很容易过这个数。
ct_tunnel_egress() (
  LC_ALL=C
  export LC_ALL
  if [ -z "$ct_ports" ]; then
    printf 'state=%s\n' "$ct_ports_skip"
    return 0
  fi
  ct_eg_port=${ct_ports%%,*}
  case "$ct_eg_port" in
    ""|0*|*[!0-9]*) printf 'state=skip:bad-ports\n'; return 0 ;;
  esac
  if [ "${#ct_eg_port}" -gt 5 ] || [ "$ct_eg_port" -gt 65535 ]; then
    printf 'state=skip:bad-ports\n'
    return 0
  fi
  if ! command -v ss >/dev/null 2>&1; then
    printf 'state=absent\nport=%s\n' "$ct_eg_port"
    return 0
  fi
  ct_eg_to=
  if command -v timeout >/dev/null 2>&1; then ct_eg_to="timeout 3"; fi
  ct_eg_detail=full
  ct_eg_out=$($ct_eg_to ss -tnpi state established '(' dport = ":$ct_eg_port" ')' 2>/dev/null)
  ct_eg_rc=$?
  if [ "$ct_eg_rc" -ne 0 ] && [ "$ct_eg_rc" -ne 124 ]; then
    ct_eg_detail=basic
    ct_eg_out=$($ct_eg_to ss -tn state established '(' dport = ":$ct_eg_port" ')' 2>/dev/null)
    ct_eg_rc=$?
  fi
  if [ "$ct_eg_rc" -ne 0 ]; then
    printf 'state=error\nport=%s\n' "$ct_eg_port"
    return 0
  fi
  printf 'state=ok\nport=%s\ndetail=%s\n' "$ct_eg_port" "$ct_eg_detail"
  printf '%s\n' "$ct_eg_out" | head -n 20000 | awk -v port="$ct_eg_port" -v detail="$ct_eg_detail" '
    function num(v, known) { return known ? sprintf("%.0f", v) : "-" }
    function scan(   i, t) {
      for (i = 1; i <= NF; i++) {
        t = $i
        if (t ~ /^bytes_acked:[0-9]+$/) { acked = substr(t, 13) + 0; has_acked = 1 }
        else if (t ~ /^bytes_sent:[0-9]+$/) { sent = substr(t, 12) + 0; has_sent = 1 }
        else if (t ~ /^bytes_received:[0-9]+$/) { recv = substr(t, 16) + 0; has_recv = 1 }
      }
    }
    function flush(   up, has_up) {
      if (!cur) return
      cur = 0
      if (!keep) return
      has_up = has_acked || has_sent
      up = has_acked ? acked : sent
      total++
      if (has_up) { tu += up; tuk = 1 }
      if (has_recv) { td += recv; tdk = 1 }
      if (name == "") {
        on++
        if (has_up) { ou += up; ouk = 1 }
        if (has_recv) { od += recv; odk = 1 }
        return
      }
      if (!(name in pc)) order[++n] = name
      pc[name]++
      if (has_up) { pu[name] += up; puk[name] = 1 }
      if (has_recv) { pd[name] += recv; pdk[name] = 1 }
    }
    # -i 的明细在 socket 行的下一行（以空白开头）
    /^[ \t]/ { if (cur && detail == "full") scan(); next }
    {
      flush()
      # 只过滤一个状态时 ss 不打 State 列；万一打了（ESTAB）就往后挪一列
      i = ($1 ~ /^[0-9]+$/) ? 1 : 2
      # 表头（Recv-Q Send-Q …）与看不懂的行不计
      if ($i !~ /^[0-9]+$/ || $(i + 1) !~ /^[0-9]+$/) next
      # 对端地址：127.0.0.1:7891、[::1]:7891、[::ffff:127.0.0.1]:7891、老版本的 ::1:7891，可能带 %lo
      peer = $(i + 3)
      pp = peer
      sub(/.*:/, "", pp)
      host = substr(peer, 1, length(peer) - length(pp) - 1)
      gsub(/\[/, "", host)
      gsub(/\]/, "", host)
      sub(/%.*/, "", host)
      keep = (pp == port) && (host ~ /^127\./ || host == "::1" || host ~ /^::ffff:127\./)
      cur = 1
      name = ""
      has_acked = has_sent = has_recv = 0
      acked = sent = recv = 0
      if (detail != "full") next
      # users:(("codex",pid=1234,fd=23)) 或老格式 users:(("codex",1234,23))：取第一个进程的名字
      if (match($0, /users:\(\("[^"]*"/)) {
        name = substr($0, RSTART + 9, RLENGTH - 10)
        gsub(/[^A-Za-z0-9._+-]/, "_", name)
        if (length(name) > 32) name = substr(name, 1, 32)
      }
      # 少数版本把 -i 的明细接在同一行
      scan()
    }
    END {
      flush()
      printf "total=%.0f|%s|%s\n", total, num(tu, tuk), num(td, tdk)
      if (detail == "full") printf "others=%.0f|%s|%s\n", on, num(ou, ouk), num(od, odk)
      printf "progs=%.0f\n", n
      for (k = 1; k <= 20; k++) {
        best = ""
        for (j = 1; j <= n; j++) {
          u = order[j]
          if (u in picked) continue
          if (best == "" || pc[u] > pc[best] || (pc[u] == pc[best] && pd[u] > pd[best])) best = u
        }
        if (best == "") break
        picked[best] = 1
        printf "prog=%s|%.0f|%s|%s\n", best, pc[best], num(pu[best], puk[best]), num(pd[best], pdk[best])
      }
    }'
)

# slurm（仅 slow，恒在最后）：Slurm 集群的节点与队列只读快照（sinfo / squeue，全部用户）。
# 集群的 Slurm 常装在非交互 PATH 之外（本集群 /public/slurm/bin），子 shell 里补常见位置；
# 找不到 sinfo 或 squeue → 只输出 state=absent（腾讯云 / 阿里云等非集群机器）。
# slurmctld 无响应时 sinfo/squeue 会挂住：有 coreutils timeout 就每条包 8s；超时（124）
# 不再跑回退格式，直接 state=error，保证整轮 slow 采集不被拖过 20s。
# 输出顺序：汇总行（state/version/now/tz/user/error/jobs_total/count=/jobreg_total）在前，
# node= / hop= / jobreg= / job= 数据行在后——段被 head -c 截断时只丢尾部数据行，汇总不丢。
# jobreg=JobID|ArrayJobID|ArrayTaskID|Name|WorkDir|StdOut|StdErr|Command（v2.49，只含当前用户的作业；
# 解析在 lib/jobs/registry.mjs，lib/slurm.mjs 不认识的键一律忽略，旧解析器不受影响）。
# -O 格式带 `:|` 时字段无填充、行尾多一个 |，这里统一剥掉；Reason / Name 放在行尾
# （管理员 / 用户自由文本可能含 |，解析端把剩余部分拼回去）。
#
# 直连节点：Slurm 登记过（scontrol 看得到）、却不在任何分区里的节点（sinfo -N 不列，
# 本集群的 node04），从登录节点 ssh 跳过去只读采集 CPU / 内存 / GPU。最多 3 个，每个最多 6s；
# sinfo 失败时整段跳过（连节点清单都拿不到）。
#   - `ssh -n` 必不可少：本脚本经 stdin 送达（sh -s），内层 ssh 若读 stdin 会吞掉脚本剩余部分。
#   - BatchMode + 不写 known_hosts（不加 accept-new、UpdateHostKeys=no）+ 不建 ControlMaster：
#     远端零落盘；主机密钥不在 known_hosts 里就直接判为连不上。
#   - 节点名走 case 白名单（[A-Za-z0-9._-]，不以 - 开头），不合法的跳过。
# 输出：hop=<名>|<ok|timeout|unreachable>|<scontrol State 原文>，随后 ok 节点的
# hopkv=<名>|<远端一行 key=value>（每节点最多 48 行；GPU 的 gpu= / gpuapp= 行与主采集的 gpu 段
# 同一格式，含温度、功耗与进程名）。放在 node= 与 job= 之间：
# 队列很长触到段上限时截掉的是尾部作业行，直连节点不受影响。
#
# ct_hop_script 在直连节点的登录 shell 里执行（整段单引号，内部不得出现单引号）。
# CPU 利用率取 /proc/stat 间隔 1 秒的两帧差分——直连节点没有跨轮缓存，无状态更简单，
# 这是有意取舍（主采集的 cpu-stat 段仍是跨轮差分、远端不 sleep）。LC_ALL=C：node04 的
# 默认 locale 是中文，free 等输出会本地化。
# gpuapp= 行尾的作业号与主采集同一取法（ct_job_of 的逻辑在这里重写一遍：这段脚本单独送到
# 直连节点执行，用不到上面的函数）；r 是只给测试用的文件系统前缀（同 CT_FS_ROOT）。
ct_hop_script='LC_ALL=C; export LC_ALL
r=
case "${CT_FS_ROOT:-}" in ""|*[!A-Za-z0-9/._-]*) ;; /*) r=$CT_FS_ROOT ;; esac
# 属主 / 已运行秒数 / 命令行（与登录节点那份 ct_proc_of 同一逻辑，结果放 gu / ge / gc）
ct_proc_of() {
  gpid=$1
  gu= ge= gc=
  set -- $(ps -o user:32=,etimes=,args= -p "$gpid" 2>/dev/null)
  if [ $# -eq 0 ]; then set -- $(ps -o user:32=,args= -p "$gpid" 2>/dev/null); fi
  gu=${1:-}
  if [ $# -ge 2 ]; then
    shift
    case "$1" in
      ""|*[!0-9]*) ;;
      *)
        ge=$1
        if [ $# -ge 2 ]; then shift; fi
        ;;
    esac
    gc=$*
    if [ -n "$gc" ]; then gc=$(printf "%s" "$gc" | head -c 200); fi
  fi
}
printf "user=%s\n" "$(id -un 2>/dev/null)"
printf "nproc=%s\n" "$(nproc 2>/dev/null)"
printf "load=%s\n" "$(cut -d " " -f1-3 /proc/loadavg 2>/dev/null)"
printf "uptime=%s\n" "$(cut -d . -f1 /proc/uptime 2>/dev/null)"
printf "cpu1=%s\n" "$(sed -n 1p /proc/stat 2>/dev/null)"
sleep 1
printf "cpu2=%s\n" "$(sed -n 1p /proc/stat 2>/dev/null)"
sed -n -e "s/^MemTotal: *\([0-9]*\) kB$/mem_total_kb=\1/p" -e "s/^MemAvailable: *\([0-9]*\) kB$/mem_avail_kb=\1/p" /proc/meminfo 2>/dev/null
if command -v nvidia-smi >/dev/null 2>&1; then
  g=$(nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null | head -n 16)
  if [ -z "$g" ]; then g=$(nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 16 | sed "s/\$/, , /"); fi
  if [ -n "$g" ]; then printf "%s\n" "$g" | sed "s/^/gpu=/"; fi
  nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null | head -n 64 | while IFS=", " read -r u p m; do
    case "$p" in ""|*[!0-9]*) continue ;; esac
    j=
    if [ -r "$r/proc/$p/cgroup" ]; then
      while IFS= read -r l; do
        c=${l#*:}; c=${c#*:}
        case "$c" in /slurm/uid_[0-9]*/job_[0-9]*|/slurm_*/uid_[0-9]*/job_[0-9]*|/system.slice/*slurmstepd.scope/job_[0-9]*) j=${c#*/job_}; j=${j%%/*}; break ;; esac
      done < "$r/proc/$p/cgroup"
    fi
    case "$j" in *[!0-9]*) j= ;; esac
    ct_proc_of "$p"
    printf "gpuproc=%s|%s|%s|%s|%s|%s|%s\n" "$u" "$p" "$m" "$gu" "$ge" "$j" "$gc"
  done
fi'

ct_slurm() (
  PATH="$PATH:/public/slurm/bin:/opt/slurm/bin:/usr/local/slurm/bin"
  LC_ALL=C
  export PATH LC_ALL
  if ! command -v sinfo >/dev/null 2>&1 || ! command -v squeue >/dev/null 2>&1; then
    printf 'state=absent\n'
    return 0
  fi
  ct_to=
  if command -v timeout >/dev/null 2>&1; then ct_to="timeout 8"; fi

  ct_sl_state=ok
  ct_sl_error=
  ct_sl_jobs=
  ct_sl_user=$(id -un 2>/dev/null)
  ct_scope_squeue() {
    if [ "$ct_sl_user" = root ]; then $ct_to squeue "$@";
    else $ct_to squeue -u "$ct_sl_user" "$@"; fi
  }

  ct_sl_nodes=$($ct_to sinfo -h -N -O "NodeList:|,StateLong:|,CPUsState:|,CPUsLoad:|,FreeMem:|,Memory:|,AllocMem:|,Gres:|,GresUsed:|,Partition:|,Reason:|" 2>/dev/null)
  ct_rc=$?
  if [ "$ct_rc" -eq 0 ]; then
    ct_sl_nodes=$(printf '%s\n' "$ct_sl_nodes" | sed 's/|$//')
  elif [ "$ct_rc" -ne 124 ]; then
    ct_sl_nodes=$($ct_to sinfo -h -N -o "%N|%T|%C|%O|%e|%m||%G||%P|%E" 2>/dev/null)
    ct_rc=$?
  fi
  if [ "$ct_rc" -eq 124 ]; then
    ct_sl_state=error
    ct_sl_error=sinfo-timeout
    ct_sl_nodes=
  elif [ "$ct_rc" -ne 0 ]; then
    ct_sl_state=error
    ct_sl_error=sinfo-failed
    ct_sl_nodes=
  fi

  # sinfo 超时说明 slurmctld 无响应，squeue 必然同样挂住：跳过，别再等 8s。
  if [ "$ct_sl_error" != sinfo-timeout ]; then
    ct_sl_jobs=$(ct_scope_squeue -h -O "JobID:|,UserName:|,Partition:|,State:|,TimeUsed:|,TimeLimit:|,NumNodes:|,NumCPUs:|,tres-alloc:|,tres-per-node:|,MinMemory:|,SubmitTime:|,StartTime:|,Reason:|,NodeList:|,Name:|" 2>/dev/null)
    ct_rc=$?
    if [ "$ct_rc" -eq 0 ]; then
      ct_sl_jobs=$(printf '%s\n' "$ct_sl_jobs" | sed 's/|$//')
    elif [ "$ct_rc" -ne 124 ]; then
      ct_sl_jobs=$(ct_scope_squeue -h -o "%i|%u|%P|%T|%M|%l|%D|%C||%b|%m|%V|%S|%r|%N|%j" 2>/dev/null)
      ct_rc=$?
    fi
    if [ "$ct_rc" -ne 0 ]; then
      ct_sl_state=error
      if [ "$ct_rc" -eq 124 ]; then ct_sl_error=squeue-timeout; else ct_sl_error=squeue-failed; fi
      ct_sl_jobs=
    fi
  fi

  # v2.49 失败作业诊断的登记：当前用户自己在队 / 运行中的作业的日志路径模板（squeue -O 原样，
  # %j 等不在远端展开，本机登记表存模板、取证时再按作业号展开）。只在 squeue 没超时时查；
  # 失败（旧版 Slurm 不认 -O 字段等）就整段不出 jobreg_total，本机据此不做「作业消失」判定。
  ct_sl_reg=
  ct_sl_reg_rc=1
  ct_sl_user=$(id -un 2>/dev/null)
  case "$ct_sl_error" in
    (sinfo-timeout|squeue-timeout) ;;
    (*)
      if [ -n "$ct_sl_user" ]; then
        ct_sl_reg=$($ct_to squeue -h -u "$ct_sl_user" -O "JobID:|,ArrayJobID:|,ArrayTaskID:|,Name:|,WorkDir:|,STDOUT:|,STDERR:|,Command:|" 2>/dev/null)
        ct_sl_reg_rc=$?
      fi
      ;;
  esac

  ct_sl_hops=
  case "$ct_sl_error" in
    (sinfo-*) ;;
    (*) ct_sl_hops=$(ct_slurm_direct_nodes 2>/dev/null) ;;
  esac

  printf 'state=%s\n' "$ct_sl_state"
  printf 'version=%s\n' "$(sinfo --version 2>/dev/null | head -n 1 | awk '{ print $2 }')"
  printf 'now=%s\n' "$(date +%s 2>/dev/null)"
  printf 'tz=%s\n' "$(date +%z 2>/dev/null)"
  printf 'user=%s\n' "$(id -un 2>/dev/null)"
  if [ -n "$ct_sl_error" ]; then printf 'error=%s\n' "$ct_sl_error"; fi
  # 总数与分状态计数基于全量输出（截断前）；State 恒为第 4 列（-O / -o 两种格式一致）。
  printf 'jobs_total=%s\n' "$(printf '%s\n' "$ct_sl_jobs" | grep -c . 2>/dev/null)"
  printf '%s\n' "$ct_sl_jobs" | awk -F'|' '$4 ~ /^[A-Z_]+$/ { c[$4]++ } END { for (k in c) printf "count=%s=%d\n", k, c[k] }' 2>/dev/null
  if [ "$ct_sl_reg_rc" -eq 0 ]; then printf 'jobreg_total=%s\n' "$(printf '%s\n' "$ct_sl_reg" | grep -c . 2>/dev/null)"; fi
  printf '%s\n' "$ct_sl_nodes" | grep -v '^$' | head -n 256 | sed 's/^/node=/'
  if [ -n "$ct_sl_hops" ]; then printf '%s\n' "$ct_sl_hops"; fi
  # jobreg= 放在 job= 之前：段上限截掉的是队列尾部，登记不丢。最多 64 行、每行 1.5KB、合计 16KB
  # （按整行累计，不截半行——半行会和下一行 job= 粘在一起）。
  if [ "$ct_sl_reg_rc" -eq 0 ]; then
    printf '%s\n' "$ct_sl_reg" | grep -v '^$' | head -n 64 | sed 's/|$//' | cut -c 1-1536 | sed 's/^/jobreg=/' | awk '{ n += length($0) + 1; if (n > 16384) exit; print }'
  fi
  printf '%s\n' "$ct_sl_jobs" | grep -v '^$' | head -n 300 | sed 's/^/job=/'
)

# 直连节点采集（在 ct_slurm 的子 shell 里调用，读它的 ct_to / ct_sl_nodes）。
# scontrol 只取 NodeName 与 State 两项；不在 sinfo -N 结果里的才算直连节点。
ct_slurm_direct_nodes() {
  command -v scontrol >/dev/null 2>&1 || return 0
  command -v ssh >/dev/null 2>&1 || return 0
  ct_to_hop=
  if command -v timeout >/dev/null 2>&1; then ct_to_hop="timeout 6"; fi
  ct_known=$(printf '%s\n' "$ct_sl_nodes" | cut -d '|' -f 1)
  ct_listed=$($ct_to scontrol -o show node 2>/dev/null | head -n 512 | awk '{
    n = ""; st = ""
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^NodeName=/) n = substr($i, 10)
      else if ($i ~ /^State=/) st = substr($i, 7)
    }
    if (n != "") print n, st
  }')
  [ -n "$ct_listed" ] || return 0
  ct_hop_n=0
  printf '%s\n' "$ct_listed" | while read -r ct_hn ct_hst; do
    case "$ct_hn" in
      (""|-*|*[!A-Za-z0-9._-]*) continue ;;
    esac
    if printf '%s\n' "$ct_known" | grep -qxF "$ct_hn"; then continue; fi
    [ "$ct_hop_n" -ge 3 ] && break
    ct_hop_n=$((ct_hop_n + 1))
    # scontrol 的 State 形如 DOWN+NOT_RESPONDING / IDLE+DRAIN；模式里不写 $（会被当参数展开）。
    case "$ct_hst" in
      (*[!A-Za-z0-9_+*~-]*) ct_hst= ;;
    esac
    ct_h_out=$($ct_to_hop ssh -n -o BatchMode=yes -o ConnectTimeout=3 -o LogLevel=ERROR \
      -o UpdateHostKeys=no -o ControlMaster=no -o ControlPath=none \
      "$ct_hn" "$ct_hop_script" 2>/dev/null)
    ct_h_rc=$?
    if [ "$ct_h_rc" -eq 124 ]; then
      ct_h_status=timeout
    elif [ "$ct_h_rc" -eq 255 ] || [ -z "$ct_h_out" ]; then
      ct_h_status=unreachable
    else
      ct_h_status=ok
    fi
    printf 'hop=%s|%s|%s\n' "$ct_hn" "$ct_h_status" "$ct_hst"
    if [ "$ct_h_status" = ok ]; then
      printf '%s\n' "$ct_h_out" | grep -v '^$' | head -n 48 | sed "s/^/hopkv=$ct_hn|/"
    fi
  done
}

# reclaude-logs / reclaude-state：段名即 lib/log-tail-probe.mjs 的 DEFAULT_LOG_SOURCES id，
# 段内原文交给现有信号引擎，规则零改动。command 源保留 PATH 前缀（reclaude 装在 ~/.local/bin，
# 非交互 ssh 会话的 PATH 不含它）；旧实现另有代理注入前缀，此处不带——`reclaude logs`
# 只读本地日志文件，不出网。
ct_reclaude_logs() {
  { PATH="$HOME/.local/bin:$PATH" reclaude logs 2>&1 | tail -n 120 ; } 2>&1 | head -c 32768
}

ct_reclaude_state() {
  { cat "$HOME/.reclaude/state.json" 2>/dev/null | head -c 16384 ; } 2>&1 | head -c 16384
}

# ---------------------------------------------------------------------------
# 按 profile 输出。段顺序固定，解析端据此判定缺段。
# ---------------------------------------------------------------------------
if [ "$ct_profile" = slow ]; then
  ct_emit sys "$(ct_sys 2>/dev/null || true)"
  ct_emit cpu-stat "$(ct_cpu_stat 2>/dev/null || true)"
  ct_emit filesystem "$(ct_filesystem 2>/dev/null | head -c 4096 || true)"
  ct_emit gpu "$(ct_gpu 2>/dev/null || true)"
  ct_emit agents "$(ct_agents 2>/dev/null | head -c 2048 || true)"
  ct_emit ports "$(ct_ports_section 2>/dev/null | head -c 4096 || true)"
  ct_emit proc-top "$(ct_proc_top 2>/dev/null | head -c 1024 || true)"
  ct_emit tunnel-egress "$(ct_tunnel_egress 2>/dev/null | head -c 2048 || true)"
  ct_emit slurm "$(ct_slurm 2>/dev/null | head -c 65536 || true)"
else
  ct_emit reclaude-logs "$(ct_reclaude_logs 2>/dev/null || true)"
  ct_emit reclaude-state "$(ct_reclaude_state 2>/dev/null || true)"
  ct_emit ports "$(ct_ports_section 2>/dev/null | head -c 4096 || true)"
fi

exit 0
