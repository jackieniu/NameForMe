/**
 * 后端向 chat AI 主动请求一组策略。
 *
 * 使用场景：主策略组合跑完后可用域名不足，需要让 AI 基于「上一轮为什么没命中」
 * 的上下文重新出一套策略；而不是让后端用硬编码的兜底策略。
 *
 * 这里直接复用 chat 的 system prompt，避免再维护一份策略选择规则；
 * 用户消息里带上「上一轮情况摘要 + 本次要求方向」来引导 AI 输出不同的策略组合。
 */

import { generateText } from "ai";
import { getChatModel } from "@/lib/ai/provider";
import chatSystemPrompts from "@/lib/chat/system-prompts.json";
import { parseChatAction, type ParsedStrategy } from "@/lib/chat/parse-action";
import type { DomainRequirements } from "@/types/domain";

export interface RetryContext {
  /** 本次会话已经跑过的策略 key，AI 必须避开（避免原地打转） */
  executedKeys: string[];
  /** 这一轮具体发生了什么：候选多少、已注册多少、超预算多少 */
  triedCount: number;
  takenCount: number;
  premiumOverBudgetCount: number;
  /** 本次是第几次向 AI 要「换一套策略」，用于让 AI 逐步放开发明词路线 */
  retryRound: number;
}

function briefRequirements(req: DomainRequirements, locale: "en" | "zh"): string {
  const lines: string[] = [];
  if (locale === "zh") {
    if (req.homeScenarioLabel) lines.push(`产品类型: ${req.homeScenarioLabel}`);
    if (req.description) lines.push(`项目描述: ${req.description}`);
    if (req.market) lines.push(`目标市场: ${req.market}`);
    if (req.tone) lines.push(`品牌调性: ${req.tone}`);
  } else {
    if (req.homeScenarioLabel) lines.push(`Product type: ${req.homeScenarioLabel}`);
    if (req.description) lines.push(`Description: ${req.description}`);
    if (req.market) lines.push(`Target market: ${req.market}`);
    if (req.tone) lines.push(`Brand tone: ${req.tone}`);
  }
  return lines.join("\n");
}

function buildRetryUserMessage(
  req: DomainRequirements,
  ctx: RetryContext,
  locale: "en" | "zh",
): string {
  const brief = briefRequirements(req, locale);
  const executed = ctx.executedKeys.length
    ? ctx.executedKeys.slice(0, 12).join(" | ")
    : "(none)";

  if (locale === "zh") {
    return (
      `${brief}\n\n` +
      `## 上一轮结果\n` +
      `- 检测候选: ${ctx.triedCount}；已注册: ${ctx.takenCount}；premium 超预算: ${ctx.premiumOverBudgetCount}\n` +
      `- 已尝试策略: ${executed}\n\n` +
      `## 要求（第 ${ctx.retryRound + 1} 次重试）\n` +
      `- 不要重复已尝试过的 key。\n` +
      `- 显性语义组合已被抢注，**不要**再把整个主名围绕已知关键词；优先发明词路线。\n` +
      `- 所有策略都必须带 AI 给出的语义参数：markov_syllable 必须带 \`seed_word=\`；portmanteau 必须带 \`words=\`（≥2 个）；creative_spelling / word_combo 必须带 \`word=\`；pinyin_syllable 必须带 \`anchor=\` 并且 \`initials=\` 或 \`finals=\` 至少一个；metaphor 必须带 \`token=\` + \`word=\`；tld_hack 必须带 \`base=\` + \`tld=\`（且 tld 必须在用户后缀集中）；number_combo 必须带 \`keyword=\` + \`num=\`（tone 禁 professional/elegant/luxury；且 market=us 时仅 1–2 位数字或 19xx/20xx 年份）；repeat_syllable 必须带 \`base=\` 或 \`syllable=\`（tone 禁 professional/elegant/luxury）；pinyin_syllable tone 禁 elegant/luxury；cross_lang 必须带 \`pinyin=\` + \`en=\`；**ai_direct 必须带 \`words=\` 且每条都是最终主名**（不是关键词），一次 15–30 个、每个纯 \`[a-z0-9]\` 4–14 字符。缺参数或 tone 不匹配的策略会零产出。\n` +
      `- 本轮建议带 1 条 \`ai_direct\`：前几轮规则策略已被抢注，正好让你用直觉再起一批 brandable 主名。\n` +
      `- 用户业务关键词与真实姓名/拼音仍是首选参数来源；禁止用 \`a,b\` 之类的占位符。\n` +
      `- 直接输出 [[ACTION:GENERATE]] 与 [[STRATEGIES:...]]，选 3-4 个策略，不要追问。可用一句话告诉用户本轮换思路。`
    );
  }

  return (
    `${brief}\n\n` +
    `## Previous round\n` +
    `- Tried: ${ctx.triedCount}; taken: ${ctx.takenCount}; premium over budget: ${ctx.premiumOverBudgetCount}\n` +
    `- Strategies tried: ${executed}\n\n` +
    `## Requirements (retry #${ctx.retryRound + 1})\n` +
    `- Do not repeat any tried key.\n` +
    `- Obvious semantic combos are taken; **do not** force the whole label around the same keywords. Prefer invented-word routes.\n` +
    `- Every strategy must carry the real semantic params you provide: markov_syllable needs \`seed_word=\`; portmanteau needs \`words=\` (≥2); creative_spelling / word_combo need \`word=\`; pinyin_syllable needs \`anchor=\` AND at least one of \`initials=\`/\`finals=\`; metaphor needs \`token=\` + \`word=\`; tld_hack needs \`base=\` + \`tld=\` (and the tld must already be in the user's suffix set); number_combo needs \`keyword=\` + \`num=\` (tone must NOT be professional/elegant/luxury; and when market=us the number must be 1–2 digits or a 19xx/20xx year); repeat_syllable needs \`base=\` or \`syllable=\` (tone must NOT be professional/elegant/luxury); pinyin_syllable must NOT be used under elegant/luxury tone; cross_lang needs \`pinyin=\` + \`en=\`; **ai_direct needs \`words=\` where each entry is a final label** (not a keyword), 15–30 per call, each pure \`[a-z0-9]\` 4–14 chars. Missing params or tone mismatch → 0 output.\n` +
    `- Recommended: include 1 \`ai_direct\` this round — rule strategies already got taken in prior rounds; use your direct brand intuition to propose a fresh batch of labels.\n` +
    `- User business keywords and real names/pinyin are the preferred param sources; never use placeholders like \`a,b\`.\n` +
    `- Emit [[ACTION:GENERATE]] and [[STRATEGIES:...]] directly with 3-4 strategies. No follow-up questions. One sentence to the user is fine.`
  );
}

/**
 * 请求 chat AI 输出一套新的策略组合。
 * 失败时（模型出错 / 解析不到 [[STRATEGIES:...]] / 解析后策略全部已执行）返回 null，
 * 调用方应将此视为「穷尽」信号，不要再硬塞硬编码策略。
 */
export async function requestRetryStrategies(
  req: DomainRequirements,
  locale: "en" | "zh",
  ctx: RetryContext,
): Promise<{ strategies: ParsedStrategy[]; assistantMessage: string } | null> {
  const system = locale === "zh" ? chatSystemPrompts.zh : chatSystemPrompts.en;
  const userMessage = buildRetryUserMessage(req, ctx, locale);

  try {
    const result = await generateText({
      model: getChatModel(),
      system,
      prompt: userMessage,
      maxOutputTokens: 1024,
    });
    const text = result.text ?? "";
    const action = parseChatAction(text);
    if (action.type !== "GENERATE") return null;

    const executed = new Set(ctx.executedKeys);
    const fresh = action.strategies.filter((s) => !executed.has(s.key));
    if (!fresh.length) return null;

    return { strategies: fresh, assistantMessage: text };
  } catch (err) {
    console.error(
      "[requestRetryStrategies]",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
