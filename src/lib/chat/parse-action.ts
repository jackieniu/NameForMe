/**
 * Parse the structured action markers appended by the AI at the end of each reply.
 *
 * Expected format (last lines of reply):
 *   [[ACTION:QUESTION]]
 *   — or —
 *   [[ACTION:GENERATE]]
 *   [[STRATEGIES:word_combo:word=teach|affix_brand:keyword=teach+tier=saas|metaphor:token=light]]
 */

export type ChatAction =
  | { type: "QUESTION" }
  | { type: "GENERATE"; strategies: ParsedStrategy[] };

export type ParsedStrategy = {
  /** e.g. "word_combo" */
  name: string;
  /** e.g. "teach+english" */
  params: string;
  /** Canonical key used for dedup: name + ":" + params */
  key: string;
};

export function parseChatAction(text: string): ChatAction {
  const actionMatch = text.match(/\[\[ACTION:(QUESTION|GENERATE)\]\]/);
  if (!actionMatch) return { type: "QUESTION" };

  if (actionMatch[1] === "QUESTION") return { type: "QUESTION" };

  const stratMatch = text.match(/\[\[STRATEGIES:([^\]]+)\]\]/);
  const strategies: ParsedStrategy[] = [];
  if (stratMatch) {
    const parts = stratMatch[1]!.split("|").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const colon = part.indexOf(":");
      // name 统一小写（AI 偶尔会输出 Word_Combo / WORD_COMBO）；params 原样保留，
      // 仅两端 trim，否则 params 里真实的大小写（如 keyword=Cheng）会被破坏
      if (colon === -1) {
        const name = part.toLowerCase();
        strategies.push({ name, params: "", key: name + ":" });
      } else {
        const name = part.slice(0, colon).trim().toLowerCase();
        const params = part.slice(colon + 1).trim();
        strategies.push({ name, params, key: `${name}:${params}` });
      }
    }
  }
  return { type: "GENERATE", strategies };
}

/** Strip the [[ACTION:...]] and [[STRATEGIES:...]] markers from display text */
export function stripActionMarkers(text: string): string {
  return text
    .replace(/\[\[ACTION:(QUESTION|GENERATE)\]\]/g, "")
    .replace(/\[\[STRATEGIES:[^\]]*\]\]/g, "")
    .trimEnd();
}
