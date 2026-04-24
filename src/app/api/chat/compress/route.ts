import { generateText } from "ai";
import { z } from "zod";
import { protectAfterJsonParsed } from "@/lib/api-protection";
import { getChatModel, isLlmConfigured } from "@/lib/ai/provider";

const bodySchema = z.object({
  locale: z.enum(["en", "zh"]).optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
    }),
  ),
  turnstileToken: z.string().optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const denied = await protectAfterJsonParsed({
    req,
    turnstileToken: parsed.data.turnstileToken,
    // Turnstile token 是一次性的；compress 是低风险的辅助接口，
    // 跳过 Turnstile 校验，将唯一 token 留给 /api/domains/generate 使用。
    skipTurnstile: true,
  });
  if (denied) return denied;

  if (!isLlmConfigured()) {
    return Response.json(
      {
        error:
          "大模型配置不完整，无法压缩对话历史。请设置 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL；参见 .env.example。",
        code: "LLM_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const { locale = "en", messages } = parsed.data;
  const history = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const promptZh =
    `请将下面的对话记录压缩成一段简洁的"域名生成需求摘要"（不超过500字），` +
    `只保留最新、最有用的品牌需求、偏好、限制和关键词，去掉重复、无关、或已被用户推翻的内容。` +
    `直接输出摘要文本，不加任何标题或前缀。\n\n${history}`;

  const promptEn =
    `Compress the following conversation into a concise "domain naming requirements summary" (max 400 words). ` +
    `Keep only the latest, most useful brand requirements, preferences, constraints and keywords. ` +
    `Remove duplicates, irrelevant content, and anything the user has since changed. ` +
    `Output only the summary text, no titles or prefixes.\n\n${history}`;

  const prompt = locale === "zh" ? promptZh : promptEn;

  try {
    const { text } = await generateText({ model: getChatModel(), prompt });
    return Response.json({ summary: text.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `大模型压缩失败：${message}`, code: "LLM_ERROR" },
      { status: 502 },
    );
  }
}
