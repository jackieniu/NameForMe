import { createOpenAI } from "@ai-sdk/openai";

const DEFAULT_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

/**
 * DeepSeek 思考模式会额外消耗并返回 `reasoning_content`；对 **JSON 输出**（`response_format`）场景，
 * 在请求体中写入 `thinking: { type: "disabled" }` 可避免思维链与最终 `content` 的解析混叠。
 * 设 `LLM_DEEPSEEK_THINKING=true` 时不在此处关闭（仍走 DeepSeek 默认，思考在 JSON 任务上易拖慢/干扰解析）。
 */
function createDeepSeekJsonAwareFetch(
  baseFetch: typeof fetch = DEFAULT_FETCH,
): typeof fetch {
  return async (input, init) => {
    if (process.env.LLM_DEEPSEEK_THINKING === "true") {
      return baseFetch(input as RequestInfo, init);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!/deepseek\.com/i.test(url) || !url.includes("chat/completions")) {
      return baseFetch(input as RequestInfo, init);
    }
    const body = init?.body;
    if (typeof body !== "string" || !body) {
      return baseFetch(input as RequestInfo, init);
    }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") return baseFetch(input as RequestInfo, init);
      const rf = parsed.response_format as { type?: string } | undefined;
      if (!rf || typeof rf.type !== "string") {
        return baseFetch(input as RequestInfo, init);
      }
      if (rf.type === "json_object" || rf.type === "json_schema") {
        parsed.thinking = { type: "disabled" };
        return baseFetch(input as RequestInfo, {
          ...init,
          body: JSON.stringify(parsed),
        });
      }
    } catch {
      /* ignore */
    }
    return baseFetch(input as RequestInfo, init);
  };
}

/**
 * 通用 OpenAI 兼容大模型配置（自托管 / 换供应商时只改环境变量）。
 *
 * 三个变量均为**必填**（无任何默认值、无兼容别名）：
 * - `LLM_API_KEY`
 * - `LLM_BASE_URL`（未写 `/v1` 会自动补）
 * - `LLM_MODEL`
 *
 * 示例：
 * - DeepSeek：`LLM_BASE_URL=https://api.deepseek.com/v1` + `LLM_MODEL=deepseek-v4-flash`
 * - OpenAI：`LLM_BASE_URL=https://api.openai.com/v1` + `LLM_MODEL=gpt-4o-mini`
 * - 本地 vLLM：`LLM_BASE_URL=http://127.0.0.1:8000/v1` + `LLM_MODEL=...`
 */
let cached: ReturnType<ReturnType<typeof createOpenAI>["chat"]> | undefined;
let cacheSignature: string | undefined;

function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (t.endsWith("/v1")) return t;
  return `${t}/v1`;
}

/** API 基址（含 `/v1` 后缀）；未配置时返回 undefined。 */
export function getLlmBaseUrl(): string | undefined {
  const raw = process.env.LLM_BASE_URL?.trim();
  return raw ? normalizeOpenAiCompatibleBaseUrl(raw) : undefined;
}

/** 模型 ID；未配置时返回 undefined。 */
export function getLlmModelId(): string | undefined {
  return process.env.LLM_MODEL?.trim() || undefined;
}

export function getLlmApiKey(): string | undefined {
  return process.env.LLM_API_KEY?.trim() || undefined;
}

/** 三要素（KEY + BASE_URL + MODEL）全部到位才算配置完整。 */
export function isLlmConfigured(): boolean {
  return Boolean(getLlmApiKey() && getLlmBaseUrl() && getLlmModelId());
}

function buildCacheSignature(): string {
  return `${getLlmBaseUrl() ?? ""}|${getLlmApiKey() ?? ""}|${getLlmModelId() ?? ""}`;
}

/**
 * 对话与域名精炼/打分共用同一模型实例（懒加载；配置变更时自动重建）。
 * 缺少任一必填变量时抛错，错误信息明确指向缺失项。
 */
export function getChatModel() {
  const apiKey = getLlmApiKey();
  const baseURL = getLlmBaseUrl();
  const modelId = getLlmModelId();

  const missing: string[] = [];
  if (!apiKey) missing.push("LLM_API_KEY");
  if (!baseURL) missing.push("LLM_BASE_URL");
  if (!modelId) missing.push("LLM_MODEL");
  if (missing.length > 0) {
    throw new Error(
      `大模型配置不完整，缺少环境变量：${missing.join("、")}。请参见 .env.example。`,
    );
  }

  const sig = buildCacheSignature();
  if (cached && cacheSignature === sig) return cached;

  const client = createOpenAI({
    baseURL,
    apiKey,
    fetch: createDeepSeekJsonAwareFetch(),
  });
  cached = client.chat(modelId!);
  cacheSignature = sig;
  return cached;
}
