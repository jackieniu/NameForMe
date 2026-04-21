import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { protectAfterJsonParsed } from "@/lib/api-protection";
import { getChatModel, isLlmConfigured } from "@/lib/ai/provider";
import chatSystemPrompts from "@/lib/chat/system-prompts.json";
import { logChat } from "@/lib/ai-logger";
import { isGenProgressUiMessage } from "@/lib/chat/strip-assistant-progress-hallucination";

const bodySchema = z.looseObject({
  messages: z.array(z.unknown()),
  locale: z.enum(["en", "zh"]).optional(),
  id: z.string().optional(),
  trigger: z.string().optional(),
  messageId: z.string().optional(),
  turnstileToken: z.string().optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const denied = await protectAfterJsonParsed({
    req,
    turnstileToken: parsed.data.turnstileToken,
  });
  if (denied) return denied;

  const locale = parsed.data.locale ?? "en";
  const messages = (parsed.data.messages as UIMessage[]).filter((m) => !isGenProgressUiMessage(m));

  if (!isLlmConfigured()) {
    return new Response(
      JSON.stringify({
        error:
          "未配置大模型 API。请在环境变量中设置 LLM_API_KEY（或 OPENAI_API_KEY / DEEPSEEK_API_KEY），" +
          "可选 LLM_BASE_URL、LLM_MODEL；参见 .env.example。",
        code: "LLM_NOT_CONFIGURED",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const system = locale === "zh" ? chatSystemPrompts.zh : chatSystemPrompts.en;

  const simplifiedMessages = messages.map((m) => ({
    role: m.role as string,
    content: m.parts
      .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
      .join(""),
  }));

  const startTs = Date.now();

  try {
    const result = streamText({
      model: getChatModel(),
      system,
      messages: await convertToModelMessages(messages),
      onFinish: ({ text }) => {
        logChat({
          locale,
          system,
          messages: simplifiedMessages,
          response: text,
          durationMs: Date.now() - startTs,
        });
      },
    });
    return result.toUIMessageStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logChat({
      locale,
      system,
      messages: simplifiedMessages,
      error: message,
      durationMs: Date.now() - startTs,
    });
    return new Response(
      JSON.stringify({
        error: `大模型调用失败：${message}`,
        code: "LLM_ERROR",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
