import { escapeHtml } from "../store.js";

const HELP = {
  hostkey: { why: "先确认连接的是管理员提供的服务器，再进行登录。", doing: "正在检查网络和服务器指纹。", next: "和管理员提供的指纹核对，一致后点「指纹一致，继续」。" },
  key: { why: "这台电脑需要自己的登录密钥；私钥留在本机，只有公钥会发到集群。", doing: "正在准备本机密钥，已有可用密钥会复用。", next: "自动完成，无需手动生成或复制密钥文件。" },
  authorize: { why: "把这台电脑的公钥添加到你自己的集群账号，之后即可免密连接。", doing: "正在验证公钥授权，已经授权就直接继续。", next: "输入一次集群账号密码，工作台会自动安装公钥并验证登录。" },
  identity: { why: "让工作台后续的连接使用刚验证过的地址、账号和密钥。", doing: "正在保存并验证连接配置。", next: "自动完成；遇到已有 SSH 配置时，按对比结果选择保留或覆盖。" },
  port: { why: "每位同学使用登记过的端口，避免与其他人冲突。", doing: "正在查询并领取专属端口。", next: "自动完成，已有可复用的登记会优先沿用。" },
  tunnel: { why: "让集群上的工具可以经这台电脑连接外部服务。", doing: "正在建立通道并等待连通。", next: "保持网络连接，工作台会自动检测结果。" },
  egress: { why: "分别检查本机出网和集群经通道出网。", doing: "正在检查网络链路。", next: "如果直连外网失败，按提示选择本机正在使用的代理方式。" },
  clusterEnv: { why: "把当前账号需要的代理配置写好，新开的集群终端会自动使用。", doing: "正在同步集群上的账号配置。", next: "已有配置需要处理时会展示具体内容，确认后再继续。" },
};
const settled = new Set(["done", "skipped", "warn"]);

export function guideProgress(guide) {
  const steps = Array.isArray(guide?.steps) ? guide.steps : [];
  const completed = steps.filter((s) => settled.has(s.status)).length;
  const current = steps.find((s) => ["running", "waiting", "failed"].includes(s.status)) || steps.find((s) => !settled.has(s.status));
  const phase = guide?.phase || "idle";
  if (phase === "done" && guide?.localReadiness?.configuredIdentityMissing) return {
    completed: 0, total: steps.length, percent: 0, step: "key", title: "这台电脑缺少登录密钥，需要重新接入",
    why: "旧电脑上的接入记录不代表这台电脑已经完成公钥授权。",
    next: "点「重新接入」，工作台会准备本机密钥并重新验证，不会删除旧电脑的授权。",
  };
  const help = HELP[current?.id] || {};
  const title = phase === "idle" ? "先填写账号，随后自动检测并接入" : phase === "done" ? "集群连接已准备好" : current?.title || "继续接入";
  const next = phase === "idle" ? "连上能访问集群的校园网、单位内网或 VPN，填写地址和账号，然后点「开始接入」。"
    : phase === "done" ? guide.form?.mode === "monitor" ? "点「进入工作台」查看集群资源，需要工具通道时可以以后再配置。" : "可以进入工作台查看资源；需要使用 AI 工具时，再继续下面的安装和登录。"
      : phase === "paused" ? "点「继续」从中断的位置接着做，已完成的步骤会保留。"
        : phase === "failed" ? current?.error?.hint || "查看本步骤的错误原因，处理后点「重试」，无需从头安装密钥。"
          : phase === "waiting" ? help.next || "按当前步骤的提示确认后继续。" : help.doing || "正在检测，请稍候。";
  return { completed, total: steps.length, percent: steps.length ? Math.round(completed / steps.length * 100) : 0,
    step: current?.id || null, title, why: phase === "idle" ? "同一网络解决的是能否到达集群；登录仍需要你自己的账号和密码，或已授权的密钥。" : phase === "done" ? "连接与公钥授权已验证完成。" : help.why || "", next };
}

export function buildGuideProgressHtml(guide) {
  if (!guide?.available) return "";
  const p = guideProgress(guide);
  const readiness = guide.localReadiness;
  const localKey = readiness ? readiness.keyState === "ready" ? "本机已有专用密钥，接入时会验证是否可用。"
    : readiness.keyState === "recover-public" ? "本机已有私钥，工作台会自动补齐公钥。" : "本机尚无专用密钥，需要时会自动生成。" : "";
  const migration = readiness?.configuredIdentityMissing
    ? '<p class="ob-note">检测到配置中的密钥不在这台电脑上。请重新接入，生成本机密钥并登记公钥，无需拷贝旧电脑的私钥。</p>' : "";
  return `<section class="ob-progress" data-ob-current-step="${escapeHtml(p.step || "start")}" aria-label="动态接入指引">
    <div class="ob-progress-head"><strong>${escapeHtml(p.title)}</strong><span>${p.completed} / ${p.total} 项完成</span></div>
    <div class="ob-progress-track" role="progressbar" aria-label="集群接入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}"><i style="transform:scaleX(${p.percent / 100})"></i></div>
    ${guide.phase !== "idle" ? `<p class="ob-next-action" role="status">${escapeHtml(p.next)}</p><p class="ob-note">${escapeHtml(p.why)}</p>` : ""}
    ${guide.phase === "idle" && localKey ? `<p class="ob-note">${escapeHtml(localKey)}</p>` : ""}${migration}
    <details class="ob-key-help"><summary>新电脑、公钥和私钥说明</summary>${guide.phase === "idle" ? `<p class="ob-note">${escapeHtml(p.why)}</p>` : ""}<p class="ob-note">私钥是这台电脑的登录凭证，保存在本机。公钥会追加到你在集群上的账号，保留已有电脑的授权。同学换电脑时重新运行接入引导即可。</p></details>
  </section>`;
}
