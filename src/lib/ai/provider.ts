import { createOpenAI } from "@ai-sdk/openai";

/**
 * 通用 OpenAI 兼容大模型配置（自托管 / 换供应商时只改环境变量）。
 *
 * 三个变量均为**必填**（无任何默认值、无兼容别名）：
 * - `LLM_API_KEY`
 * - `LLM_BASE_URL`（未写 `/v1` 会自动补）
 * - `LLM_MODEL`
 *
 * 示例：
 * - DeepSeek：`LLM_BASE_URL=https://api.deepseek.com/v1` + `LLM_MODEL=deepseek-chat`
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

  const client = createOpenAI({ baseURL, apiKey });
  cached = client.chat(modelId!);
  cacheSignature = sig;
  return cached;
}
