/**
 * 接口级限流 + 黑名单。
 *
 * 存储由 `rate-storage` 抽象：
 * - 已配置 Upstash Redis：原子计数 + 黑名单，多实例一致。
 * - 未配置：不调用 `tryConsumeApiSlot`（见 `api-protection`），无全局限流。
 *
 * 流程（持久化存储可用且 `tryConsumeApiSlot` 被调用时）：
 * 1. 查黑名单；2. 全站/按 IP 日计数 +1 并获新值；3. 超阈值则拒绝并拉黑。
 *
 * Turnstile 失败次数记在进程内存（见 `noteTurnstileFailure`）。
 */

import {
  getRateStorage,
  hasPersistedRateStorage,
  secondsToNextDay,
  secondsToNextHour,
} from "./rate-storage";
import type { RateStorage } from "./rate-storage";

/** 单 IP 每天（无每小时限制） */
export const API_RATE_IP_PER_DAY = 100;
/** 全站每小时 */
export const API_RATE_SITE_PER_HOUR = 1000;

/** Turnstile 连续失败阈值 / 统计窗口（内存） */
const TS_FAIL_LIMIT = 5;
const TS_FAIL_WINDOW_MS = 600_000;
const TS_BLOCK_SEC = 3_600;
/** 对 `turnstileFailTs` 进行懒清理的阈值：超过该条目数时扫一遍。 */
const TS_FAIL_MAP_SOFT_CAP = 500;

const turnstileFailTs = new Map<string, number[]>();

function sweepTurnstileFailMap(now: number): void {
  if (turnstileFailTs.size < TS_FAIL_MAP_SOFT_CAP) return;
  for (const [ip, arr] of turnstileFailTs) {
    const kept = arr.filter((t) => t > now - TS_FAIL_WINDOW_MS);
    if (kept.length === 0) turnstileFailTs.delete(ip);
    else if (kept.length !== arr.length) turnstileFailTs.set(ip, kept);
  }
}

export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.split(",")[0]?.trim() || "unknown";
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || "unknown";
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export function isIpBlocked(ip: string, storage: RateStorage = getRateStorage()): Promise<boolean> {
  return storage.isBlocked(ip);
}

/**
 * Turnstile 等低成本校验连续失败时拉黑（短期）。
 * 10 分钟窗口内失败 5 次 -> 拉黑 1 小时（写入 Redis 或内存）。
 */
export async function noteTurnstileFailure(
  ip: string,
  storage: RateStorage = getRateStorage(),
): Promise<void> {
  if (!ip || ip === "unknown") return;
  const now = Date.now();
  sweepTurnstileFailMap(now);
  const arr = (turnstileFailTs.get(ip) ?? []).filter((t) => t > now - TS_FAIL_WINDOW_MS);
  arr.push(now);
  turnstileFailTs.set(ip, arr);
  if (arr.length >= TS_FAIL_LIMIT) {
    turnstileFailTs.delete(ip);
    await storage.blockIp(ip, TS_BLOCK_SEC);
  }
}

export type ApiGateFailureKind =
  | "blocked"
  | "site_degraded"
  | "rate_ip_day";

export type ApiGateResult =
  | { ok: true }
  | { ok: false; kind: ApiGateFailureKind; retryAfterSec?: number };

/**
 * 通过校验后调用一次：全站/按 IP 日计数 +1 并判定是否超限。
 *
 * 被拒的那一次「也计入」配额，这是有意设计：
 *   - 攻击者若狂刷，每一次都会增加计数，更快触发封禁；
 *   - 下一个窗口（小时 / 天）的计数也会偏高一点，但不会穿透阈值。
 */
export async function tryConsumeApiSlot(
  ip: string,
  storage: RateStorage = getRateStorage(),
): Promise<ApiGateResult> {
  if (await storage.isBlocked(ip)) {
    return { ok: false, kind: "blocked" };
  }

  const now = new Date();
  let counts;
  try {
    counts = await storage.incrementCounters(ip, now);
  } catch (err) {
    // 限流存储（Redis 等）不可用：fail-closed。防刷是本模块的首要目标，
    // 为了 UX 放行反而会让攻击者绕过，宁可短暂 503 也不要放水。
    console.error("[rate-limit] storage failed, closing gate", err);
    return {
      ok: false,
      kind: "site_degraded",
      retryAfterSec: 60,
    };
  }

  const { siteHour, ipDay } = counts;

  if (siteHour > API_RATE_SITE_PER_HOUR) {
    return {
      ok: false,
      kind: "site_degraded",
      retryAfterSec: secondsToNextHour(now),
    };
  }

  if (ipDay > API_RATE_IP_PER_DAY) {
    await storage.blockIp(ip, secondsToNextDay(now));
    return {
      ok: false,
      kind: "rate_ip_day",
      retryAfterSec: secondsToNextDay(now),
    };
  }

  // 命中阈值（未超）：主动写黑名单，下次请求先被 isBlocked 拒绝。
  if (ipDay === API_RATE_IP_PER_DAY) {
    await storage.blockIp(ip, secondsToNextDay(now));
  }

  return { ok: true };
}

export type RateStatus = {
  ipDayUsed: number;
  ipDayLimit: number;
  ipDayLeft: number;
  siteHourUsed: number;
  siteHourLimit: number;
  siteHourLeft: number;
  /** min(ipDayLeft, siteHourLeft)；0 表示当前不可用 */
  remaining: number;
  blocked: boolean;
};

/** 只读快照；不占用配额。 */
export async function getRateStatus(
  ip: string,
  storage: RateStorage = getRateStorage(),
): Promise<RateStatus> {
  if (!hasPersistedRateStorage()) {
    const blocked = await storage.isBlocked(ip);
    const cap = Math.min(API_RATE_IP_PER_DAY, API_RATE_SITE_PER_HOUR);
    return {
      ipDayUsed: 0,
      ipDayLimit: API_RATE_IP_PER_DAY,
      ipDayLeft: API_RATE_IP_PER_DAY,
      siteHourUsed: 0,
      siteHourLimit: API_RATE_SITE_PER_HOUR,
      siteHourLeft: API_RATE_SITE_PER_HOUR,
      remaining: blocked ? 0 : cap,
      blocked,
    };
  }

  const now = new Date();
  const snap = await storage.readStatus(ip, now);

  const ipDayLeft = Math.max(0, API_RATE_IP_PER_DAY - snap.ipDay);
  const siteHourLeft = Math.max(0, API_RATE_SITE_PER_HOUR - snap.siteHour);

  const remaining = snap.blocked ? 0 : Math.min(ipDayLeft, siteHourLeft);

  return {
    ipDayUsed: snap.ipDay,
    ipDayLimit: API_RATE_IP_PER_DAY,
    ipDayLeft,
    siteHourUsed: snap.siteHour,
    siteHourLimit: API_RATE_SITE_PER_HOUR,
    siteHourLeft,
    remaining,
    blocked: snap.blocked,
  };
}
