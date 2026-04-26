import { getMemoryStorage } from "./memory";
import { UpstashRateStorage, hasUpstashRateLimitBindings } from "./upstash";
import type { RateStorage } from "./types";

export type { RateCounts, RateReadSnapshot, RateStorage } from "./types";
export { secondsToNextDay, secondsToNextHour } from "./types";

/**
 * 是否配置了 Upstash Redis（`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`）。
 * 为 true 时 `api-protection` 会启用跨进程一致的 API 配额限流。
 */
export function hasPersistedRateStorage(): boolean {
  return hasUpstashRateLimitBindings();
}

/**
 * 选择当前请求应使用的存储后端：Upstash Redis → 否则进程内存。
 */
export function getRateStorage(): RateStorage {
  if (hasUpstashRateLimitBindings()) return new UpstashRateStorage();
  return getMemoryStorage();
}

/**
 * 非计费接口专用：始终走内存，不消耗 Redis。
 * 用于 `/api/domains/check` 等对我方没有外部 LLM/计费费用的端点。
 */
export function getMemoryOnlyStorage(): RateStorage {
  return getMemoryStorage();
}
