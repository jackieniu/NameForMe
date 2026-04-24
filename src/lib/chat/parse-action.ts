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

/**
 * Known valid strategy names (must match CANDIDATE_STRATEGY_HINTS in domain-generation.ts).
 * We use this to reject garbage tokens the AI occasionally emits inside the marker.
 */
const VALID_STRATEGY_NAMES = new Set([
  "word_combo",
  "affix_brand",
  "creative_spelling",
  "metaphor",
  "portmanteau",
  "tld_hack",
  "number_combo",
  "pinyin_syllable",
  "markov_syllable",
  "repeat_syllable",
  "cross_lang",
  "ai_direct",
]);

/**
 * Normalize full-width / CJK punctuation that the AI occasionally emits instead of ASCII.
 * e.g. 【 → [ , 】 → ] , （ → ( , ） → ) , ｜ → |
 */
function normalizeBrackets(text: string): string {
  return text
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/｛/g, "{")
    .replace(/｝/g, "}")
    .replace(/｜/g, "|")
    .replace(/〔/g, "[")
    .replace(/〕/g, "]");
}

/**
 * Extract strategies from the raw AI text using multiple fallback patterns.
 * Returns as many valid strategies as can be parsed; invalid/unparseable entries
 * are silently discarded so partial output is still usable.
 */
function extractStrategies(rawText: string): ParsedStrategy[] {
  // Normalize full-width brackets first so subsequent regexes work uniformly
  const text = normalizeBrackets(rawText);

  // Try patterns in decreasing strictness order.
  // Each pattern must capture the content between [[STRATEGIES: and its closing marker.
  const patterns: RegExp[] = [
    // 1. Standard closing ]]
    /\[\[STRATEGIES:([\s\S]*?)\]\]/,
    // 2. Single ] followed by optional whitespace + ] or } or ) (AI typo)
    /\[\[STRATEGIES:([\s\S]*?)\][\s]*[\])}]/,
    // 3. Single ] and then end-of-string or start of next [[
    /\[\[STRATEGIES:([\s\S]*?)\](?=\s*$|\s*\[\[)/m,
    // 4. Greedy grab until next [[ or end of text (last resort)
    /\[\[STRATEGIES:([\s\S]+?)(?=\[\[|$)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const content = match[1].trim();
    if (!content) continue;

    // Split by | (pipe) or newlines; either can be used as a delimiter
    const parts = content
      .split(/\||\r?\n/)
      .map((s) => s.trim())
      // Strip stray bracket/punctuation wrappers the AI sometimes emits
      .map((s) => s.replace(/^[\[\](){}\s]+|[\[\](){}\s]+$/g, "").trim())
      .filter(Boolean);

    const strategies: ParsedStrategy[] = [];
    for (const part of parts) {
      const colon = part.indexOf(":");
      // name 统一小写（AI 偶尔会输出 Word_Combo / WORD_COMBO）；params 原样保留，
      // 仅两端 trim，否则 params 里真实的大小写（如 keyword=Cheng）会被破坏
      if (colon === -1) {
        const name = part.toLowerCase().replace(/\s+/g, "_");
        if (!VALID_STRATEGY_NAMES.has(name)) continue; // discard unknown tokens
        strategies.push({ name, params: "", key: name + ":" });
      } else {
        const name = part.slice(0, colon).trim().toLowerCase().replace(/\s+/g, "_");
        if (!VALID_STRATEGY_NAMES.has(name)) continue; // discard unknown tokens
        const params = part.slice(colon + 1).trim();
        strategies.push({ name, params, key: `${name}:${params}` });
      }
    }

    if (strategies.length > 0) return strategies;
  }

  return [];
}

export function parseChatAction(rawText: string): ChatAction {
  const text = normalizeBrackets(rawText);
  const actionMatch = text.match(/\[\[ACTION:(QUESTION|GENERATE)\]\]/);
  if (!actionMatch) return { type: "QUESTION" };

  if (actionMatch[1] === "QUESTION") return { type: "QUESTION" };

  // extractStrategies also normalizes internally, but pass normalized text for consistency
  const strategies = extractStrategies(text);
  return { type: "GENERATE", strategies };
}

/** Strip all machine-only markers from display text */
export function stripActionMarkers(rawText: string): string {
  const text = normalizeBrackets(rawText);
  return text
    .replace(/\[\[ACTION:(QUESTION|GENERATE)\]\]/g, "")
    .replace(/\[\[STRATEGIES:[\s\S]*?\]\]/g, "")
    .replace(/\[\[STRATEGIES:[\s\S]*?\][\s]*[\])}]/g, "")
    .replace(/\[\[STRATEGIES:[\s\S]+?(?=\[\[|$)/g, "")
    .replace(/\[\[SUFFIXES:[^\]]*\]\]/g, "")
    .replace(/\[\[SUFFIXES:[^\]]*\][\s]*[\])}]?/g, "")
    .replace(/\[\[BUDGET:[^\]]*\]\]/g, "")
    .replace(/\[\[BUDGET:[^\]]*\][\s]*[\])}]?/g, "")
    .trimEnd();
}

// ---------------------------------------------------------------------------
// Requirements override markers
// ---------------------------------------------------------------------------

export type RequirementsOverride = {
  suffixes?: string[];
  budget?: { amount: number; currency: string };
};

/**
 * Parse [[SUFFIXES:.com|.io|.ai]] and [[BUDGET:10000|CNY]] markers.
 * These are emitted by the AI when the user explicitly asks to change suffixes
 * or the price limit. They are stripped from display text by stripActionMarkers.
 */
export function parseRequirementsOverride(rawText: string): RequirementsOverride {
  const text = normalizeBrackets(rawText);
  const result: RequirementsOverride = {};

  const sfxMatch = text.match(/\[\[SUFFIXES:([^\]]+)\]\]/);
  if (sfxMatch) {
    const sfxs = sfxMatch[1]!
      .split(/[|｜]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sfxs.length > 0) result.suffixes = sfxs;
  }

  const budgetMatch = text.match(/\[\[BUDGET:(\d+)[|｜](CNY|USD)\]\]/);
  if (budgetMatch) {
    result.budget = {
      amount: parseInt(budgetMatch[1]!, 10),
      currency: budgetMatch[2]!,
    };
  }

  return result;
}

/**
 * Snap a raw budget amount to the nearest valid step for the given currency.
 *
 * CNY steps: 100, 1000, 10000, 100000, 0 (unlimited)
 * USD steps: 10,  100,  1000,  10000,  0 (unlimited)
 *
 * Returns 0 when amount is 0 or negative (interpreted as "no limit").
 */
export function snapBudgetAmount(amount: number, currency: string): number {
  if (amount <= 0) return 0;
  const steps =
    currency === "CNY"
      ? [100, 1000, 10000, 100000]
      : [10, 100, 1000, 10000];
  return steps.find((s) => s >= amount) ?? steps[steps.length - 1]!;
}
