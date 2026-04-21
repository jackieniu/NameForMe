import { createOpenAI } from "@ai-sdk/openai";

/**
 * 通用 OpenAI 兼容大模型配置（自托管 / 换供应商时只改环境变量）。
 *
 * 优先级（密钥）：`LLM_API_KEY` → `OPENAI_API_KEY` → `DEEPSEEK_API_KEY`（兼容旧名）
 * 默认基址与模型：DeepSeek 官方（未设 `LLM_BASE_URL` 时）
 *
 * 示例：
 * - DeepSeek：`LLM_API_KEY` + 默认即可
 * - OpenAI：`LLM_API_KEY` + `LLM_BASE_URL=https://api.openai.com/v1` + `LLM_MODEL=gpt-4o-mini`
 * - 本地 vLLM：`LLM_BASE_URL=http://127.0.0.1:8000/v1` + `LLM_MODEL=...`
 */
let cached: ReturnType<ReturnType<typeof createOpenAI>["chat"]> | undefined;
let cacheSignature: string | undefined;

function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (t.endsWith("/v1")) return t;
  return `${t}/v1`;
}

/** 解析后的 API 基址（含 `/v1` 后缀，供 OpenAI 兼容 SDK 使用）。 */
export function getLlmBaseUrl(): string {
  const fromEnv =
    process.env.LLM_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim();
  if (fromEnv) return normalizeOpenAiCompatibleBaseUrl(fromEnv);
  return "https://api.deepseek.com/v1";
}

export function getLlmModelId(): string {
  return (
    process.env.LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "deepseek-chat"
  );
}

export function getLlmApiKey(): string | undefined {
  return (
    process.env.LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    undefined
  );
}

export function isLlmConfigured(): boolean {
  return Boolean(getLlmApiKey());
}

function buildCacheSignature(): string {
  return `${getLlmBaseUrl()}|${getLlmApiKey() ?? ""}|${getLlmModelId()}`;
}

/**
 * 对话与域名精炼/打分共用同一模型实例（懒加载；配置变更时自动重建）。
 */
export function getChatModel() {
  const apiKey = getLlmApiKey();
  if (!apiKey) {
    throw new Error(
      "未配置大模型 API 密钥。请设置 LLM_API_KEY（或兼容 OPENAI_API_KEY / DEEPSEEK_API_KEY），" +
        "可选 LLM_BASE_URL、LLM_MODEL；详见仓库内 .env.example。",
    );
  }
  const sig = buildCacheSignature();
  if (cached && cacheSignature === sig) return cached;

  const client = createOpenAI({
    baseURL: getLlmBaseUrl(),
    apiKey,
  });
  cached = client.chat(getLlmModelId());
  cacheSignature = sig;
  return cached;
}
