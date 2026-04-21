/**
 * 模型有时会仿写「累计待检测 / 可注册数量」等进度话术，与真实后端统计混淆。
 * 仅用于展示层：从**对话助手**正文中剥掉这些行，真实进度仍由 `gen-progress-*` 气泡展示。
 */
export const GEN_PROGRESS_MESSAGE_ID_PREFIX = "gen-progress-";

/** 生成进度气泡（检测/评分摘要等）：仅展示用，不得进入发给对话模型的历史 */
export function isGenProgressUiMessage(message: { id?: string }): boolean {
  const id = message.id ?? "";
  return id.startsWith(GEN_PROGRESS_MESSAGE_ID_PREFIX);
}

function shouldDropAssistantLine(trimmed: string): boolean {
  if (!trimmed) return false;
  // 只删「模型明显在编进度统计」的几种固定开头；其余正文不动，避免误伤。
  // 真实的 `gen-progress-*` 气泡走前缀旁路，不会进到这个函数里。
  if (/^本轮已累计生成/.test(trimmed)) return true;
  if (/^累计检测出/.test(trimmed)) return true;
  if (/^本轮共生成\s*\d+\s*个域名/.test(trimmed)) return true;
  return false;
}

export function stripAssistantProgressHallucination(text: string): string {
  const next = text
    .split("\n")
    .filter((line) => !shouldDropAssistantLine(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return next.trimEnd();
}
