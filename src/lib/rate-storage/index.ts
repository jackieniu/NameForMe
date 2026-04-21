import { tryCreateCloudflareStorage } from "./cloudflare";
import { getMemoryStorage } from "./memory";
import type { RateStorage } from "./types";

export type { RateCounts, RateReadSnapshot, RateStorage } from "./types";
export { secondsToNextDay, secondsToNextHour } from "./types";

/**
 * 选择当前请求应使用的存储后端。
 *
 * - Cloudflare Pages / Workers（检测到 BLOCKLIST + DB 绑定）：用 KV + D1。
 * - 其他（本地开发、未配置绑定）：回退到内存。
 *
 * 每次调用都尝试拿 Cloudflare 绑定，命中后复用同一 DB/KV 实例；未命中则返回进程内单例。
 */
export function getRateStorage(): RateStorage {
  const cf = tryCreateCloudflareStorage();
  if (cf) return cf;
  return getMemoryStorage();
}

/**
 * 非计费接口专用：始终走内存，不消耗 KV / D1。
 * 用于 `/api/domains/check` 这类对我方没有外部费用的端点。
 */
export function getMemoryOnlyStorage(): RateStorage {
  return getMemoryStorage();
}
