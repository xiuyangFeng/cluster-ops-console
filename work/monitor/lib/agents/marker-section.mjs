// 适配器远端组合命令的 echo 标记分段："...<begin>\n<content>\n<end>..." → 标记之间的原文（trim）。
// begin 缺失返回 null（SSH 未到达远端 ≠ 内容为空，由调用方决定兜底）；end 缺失（输出被截断）取到结尾。
export function extractMarkerSection(text, beginMarker, endMarker) {
  const beginIdx = text.indexOf(beginMarker);
  if (beginIdx === -1) return null;
  const afterBegin = text.slice(beginIdx + beginMarker.length);
  const endIdx = afterBegin.indexOf(endMarker);
  return (endIdx === -1 ? afterBegin : afterBegin.slice(0, endIdx)).trim();
}
