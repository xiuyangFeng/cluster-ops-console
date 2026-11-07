// 只解释确切已知的建议项；原始输出与 fail 计数保持不变。
export function explainDoctorAdvice(item) {
  if (item?.name === 'updates' && item.text === 'update configuration is locally consistent') {
    return { maintenance: true, text: '更新配置本地一致；这条提示本身不表示更新失败，无需重启通道' };
  }
  if (item?.name === 'threads' && item.text === 'rollout files are missing from the state DB') {
    return { maintenance: true, text: '会话记录与状态库索引不一致；通常不影响当前请求，若旧会话无法查找或恢复，再备份后检查' };
  }
  return { maintenance: false, text: `${item?.name || ''}：${item?.text || ''}` };
}
export function doctorAttentionCount(summary) {
  const items = Array.isArray(summary?.warnItems) ? summary.warnItems : [];
  const maintenance = new Set(items.filter(x => explainDoctorAdvice(x).maintenance).map(x => `${x.name}|${x.text}`)).size;
  return Math.max(0, (Number(summary?.warn) || 0) - maintenance);
}
export function doctorAdviceText(items) {
  return (Array.isArray(items) ? items : []).map(x => {
    const advice = explainDoctorAdvice(x);
    return advice.maintenance ? `维护提示 · ${advice.text}（原文：${x.name}：${x.text}）` : advice.text;
  }).join('；');
}
