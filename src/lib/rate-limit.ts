/**
 * 接口级限流 + 黑名单。
 *
 * 存储由 `rate-storage` 抽象：
 * - 生产 (Cloudflare Pages/Workers): KV 黑名单 + D1 原子计数，跨 isolate 一致。
 * - 本地 / 未配置绑定: 进程内内存，仅当前 isolate 有效。
 *
 * 流程：
 * 1. 查黑名单（KV 快路径，命中即拒）。
 * 2. `incrementCounters` 原子 +1 三个计数器（site_h / ip_h / ip_d）并拿到新值。
 * 3. 若任一计数器 > 阈值 -> 拒绝。被拒请求也占配额，防止攻击者卡阈值边缘。
 * 4. 若计数器 ≥ 阈值 -> 主动写 KV 黑名单（下次直接快路径拒绝，省 D1 一次 batch）。
 *
 * Turnstile 失败频次仍保留在内存中（轻量、每次失败都已打过 CF siteverify，
 * 攻击成本已经足够高，跨 isolate 不一致带来的「多个 isolate 各容忍 5 次」可接受）。
 */

import { getRateStorage, secondsToNextDay, secondsToNextHour } from "./rate-storage";
import type { RateStorage } from "./rate-storage";

/** 单 IP：每小时、每天 */
export const API_RATE_IP_PER_HOUR = 100;
export const API_RATE_IP_PER_DAY = 500;
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
 * 10 分钟窗口内失败 5 次 -> 拉黑 1 小时（写入 KV / 内存）。
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
  | "rate_ip_hour"
  | "rate_ip_day";

export type ApiGateResult =
  | { ok: true }
  | { ok: false; kind: ApiGateFailureKind; retryAfterSec?: number };

/**
 * 通过校验后调用一次：原子 +1 三个计数器并判定是否超限。
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
    // 后端（D1）不可用：fail-closed。防刷是本模块的首要目标，
    // 为了 UX 放行反而会让攻击者绕过，宁可短暂 503 也不要放水。
    console.error("[rate-limit] storage failed, closing gate", err);
    return {
      ok: false,
      kind: "site_degraded",
      retryAfterSec: 60,
    };
  }

  const { siteHour, ipHour, ipDay } = counts;

  if (siteHour > API_RATE_SITE_PER_HOUR) {
    return {
      ok: false,
      kind: "site_degraded",
      retryAfterSec: secondsToNextHour(now),
    };
  }

  // 先判 day（TTL 更长）再判 hour；同时超时确保封到当日结束，避免 1 小时后解封。
  if (ipDay > API_RATE_IP_PER_DAY) {
    await storage.blockIp(ip, secondsToNextDay(now));
    return {
      ok: false,
      kind: "rate_ip_day",
      retryAfterSec: secondsToNextDay(now),
    };
  }
  if (ipHour > API_RATE_IP_PER_HOUR) {
    await storage.blockIp(ip, secondsToNextHour(now));
    return {
      ok: false,
      kind: "rate_ip_hour",
      retryAfterSec: secondsToNextHour(now),
    };
  }

  // 命中阈值（未超）：主动写黑名单，下一次请求直接走 KV 快路径拒绝。
  if (ipDay === API_RATE_IP_PER_DAY) {
    await storage.blockIp(ip, secondsToNextDay(now));
  } else if (ipHour === API_RATE_IP_PER_HOUR) {
    await storage.blockIp(ip, secondsToNextHour(now));
  }

  return { ok: true };
}

export type RateStatus = {
  ipHourUsed: number;
  ipHourLimit: number;
  ipHourLeft: number;
  ipDayUsed: number;
  ipDayLimit: number;
  ipDayLeft: number;
  siteHourUsed: number;
  siteHourLimit: number;
  siteHourLeft: number;
  /** min(ipHourLeft, ipDayLeft, siteHourLeft)；0 表示当前不可用 */
  remaining: number;
  blocked: boolean;
};

/** 只读快照；不占用配额。 */
export async function getRateStatus(
  ip: string,
  storage: RateStorage = getRateStorage(),
): Promise<RateStatus> {
  const now = new Date();
  const snap = await storage.readStatus(ip, now);

  const ipHourLeft = Math.max(0, API_RATE_IP_PER_HOUR - snap.ipHour);
  const ipDayLeft = Math.max(0, API_RATE_IP_PER_DAY - snap.ipDay);
  const siteHourLeft = Math.max(0, API_RATE_SITE_PER_HOUR - snap.siteHour);

  const remaining = snap.blocked ? 0 : Math.min(ipHourLeft, ipDayLeft, siteHourLeft);

  return {
    ipHourUsed: snap.ipHour,
    ipHourLimit: API_RATE_IP_PER_HOUR,
    ipHourLeft,
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
