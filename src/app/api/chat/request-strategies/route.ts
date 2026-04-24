/**
 * POST /api/chat/request-strategies
 *
 * 当前端 onFinish 解析到 [[ACTION:GENERATE]] 但无法提取到合法策略时，
 * 前端静默调用本接口重新向 AI 请求策略，最多自动重试 3 次。
 * 本接口不修改对话历史，也不向用户显示任何额外消息。
 *
 * Request body:
 *   { messages: UIMessage[], locale: "en"|"zh", requirements: DomainRequirements }
 *
 * Response:
 *   200 { strategies: ParsedStrategy[] }  — 解析成功
 *   422 { error: string }                — 重试耗尽，仍无法解析
 *   400 { error: string }                — 请求格式错误
 */

import { generateText, type UIMessage, convertToModelMessages } from "ai";
import { z } from "zod";
import { getChatModel, isLlmConfigured } from "@/lib/ai/provider";
import chatSystemPrompts from "@/lib/chat/system-prompts.json";
import { parseChatAction, type ParsedStrategy } from "@/lib/chat/parse-action";
import { isGenProgressUiMessage } from "@/lib/chat/strip-assistant-progress-hallucination";

const MAX_ATTEMPTS = 3;

const bodySchema = z.looseObject({
  messages: z.array(z.unknown()),
  locale: z.enum(["en", "zh"]).optional(),
});

function retryPrompt(locale: "en" | "zh"): string {
  if (locale === "zh") {
    return (
      "请重新输出策略标记，格式严格如下（两行，不要有其他内容）：\n" +
      "[[ACTION:GENERATE]]\n" +
      "[[STRATEGIES:策略名1:参数1|策略名2:参数2|...]]\n\n" +
      "合法策略名：word_combo, affix_brand, creative_spelling, metaphor, portmanteau, " +
      "tld_hack, number_combo, pinyin_syllable, markov_syllable, repeat_syllable, cross_lang, ai_direct\n" +
      "每条策略必须携带参数（如 word=xxx 或 words=xxx）。"
    );
  }
  return (
    "Please re-output the strategy markers in strict format (two lines only, nothing else):\n" +
    "[[ACTION:GENERATE]]\n" +
    "[[STRATEGIES:name1:params1|name2:params2|...]]\n\n" +
    "Valid strategy names: word_combo, affix_brand, creative_spelling, metaphor, portmanteau, " +
    "tld_hack, number_combo, pinyin_syllable, markov_syllable, repeat_syllable, cross_lang, ai_direct\n" +
    "Each strategy must include parameters (e.g. word=xxx or words=xxx)."
  );
}

export async function POST(req: Request) {
  if (!isLlmConfigured()) {
    return new Response(JSON.stringify({ error: "LLM not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const locale = parsed.data.locale ?? "en";
  const system = locale === "zh" ? chatSystemPrompts.zh : chatSystemPrompts.en;

  // Build message history for context (strip gen-progress bubbles)
  const uiMessages = (parsed.data.messages as UIMessage[]).filter(
    (m) => !isGenProgressUiMessage(m),
  );

  let strategies: ParsedStrategy[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // On first attempt re-send the existing conversation so AI has context;
      // on subsequent attempts append an explicit correction prompt.
      const baseMessages = await convertToModelMessages(uiMessages);
      const promptMessages =
        attempt === 0
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: retryPrompt(locale) }],
              },
            ];

      const result = await generateText({
        model: getChatModel(),
        system,
        messages: promptMessages,
        maxOutputTokens: 512,
      });

      const text = result.text ?? "";
      const action = parseChatAction(text);

      if (action.type === "GENERATE" && action.strategies.length > 0) {
        strategies = action.strategies;
        break;
      }

      console.warn(
        `[request-strategies] attempt ${attempt + 1}/${MAX_ATTEMPTS}: no strategies`,
      );
    } catch (err) {
      console.error(
        `[request-strategies] attempt ${attempt + 1}/${MAX_ATTEMPTS}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!strategies.length) {
    return new Response(
      JSON.stringify({ error: "Could not parse strategies after retries" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ strategies }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
