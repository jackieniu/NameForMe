/** 进程内内存存储；多实例/多进程不共享。未配置 Upstash 时作降级后端。 */

import {
  dayKey,
  hourKey,
  type RateCounts,
  type RateReadSnapshot,
  type RateStorage,
} from "./types";

type CounterKey = `${string}|${string}|${string}`;

const counters = new Map<CounterKey, number>();
const blocklist = new Map<string, number>();

/** 懒清理：每 N 次 increment 扫一遍过期窗口/黑名单，避免长跑内存泄漏。 */
const CLEANUP_EVERY_N_OPS = 500;
let opsSinceCleanup = 0;

function k(scope: string, key: string, window: string): CounterKey {
  return `${scope}|${key}|${window}`;
}

function readCount(scope: string, key: string, window: string): number {
  return counters.get(k(scope, key, window)) ?? 0;
}

function bump(scope: string, key: string, window: string): number {
  const ck = k(scope, key, window);
  const next = (counters.get(ck) ?? 0) + 1;
  counters.set(ck, next);
  return next;
}

function cleanup(now: Date): void {
  const oldHour = hourKey(new Date(now.getTime() - 25 * 3600_000));
  const oldDay = dayKey(new Date(now.getTime() - 3 * 86400_000));
  for (const ck of counters.keys()) {
    const sep1 = ck.indexOf("|");
    const sep2 = ck.lastIndexOf("|");
    if (sep1 < 0 || sep2 <= sep1) continue;
    const scope = ck.slice(0, sep1);
    const win = ck.slice(sep2 + 1);
    if (scope === "site_h" && win < oldHour) {
      counters.delete(ck);
    } else if (scope === "ip_d" && win < oldDay) {
      counters.delete(ck);
    }
  }
  const nowMs = now.getTime();
  for (const [ip, until] of blocklist) {
    if (until <= nowMs) blocklist.delete(ip);
  }
}

function maybeCleanup(now: Date): void {
  opsSinceCleanup++;
  if (opsSinceCleanup < CLEANUP_EVERY_N_OPS) return;
  opsSinceCleanup = 0;
  cleanup(now);
}

class MemoryRateStorage implements RateStorage {
  async isBlocked(ip: string): Promise<boolean> {
    if (!ip || ip === "unknown") return false;
    const until = blocklist.get(ip);
    if (!until) return false;
    if (Date.now() >= until) {
      blocklist.delete(ip);
      return false;
    }
    return true;
  }

  async blockIp(ip: string, ttlSec: number): Promise<void> {
    if (!ip || ip === "unknown") return;
    const until = Date.now() + Math.max(60, ttlSec) * 1000;
    const prev = blocklist.get(ip) ?? 0;
    blocklist.set(ip, Math.max(prev, until));
  }

  async incrementCounters(ip: string, now: Date): Promise<RateCounts> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    const out: RateCounts = {
      siteHour: bump("site_h", "", hw),
      ipDay: bump("ip_d", ip, dw),
    };
    maybeCleanup(now);
    return out;
  }

  async readStatus(ip: string, now: Date): Promise<RateReadSnapshot> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    return {
      siteHour: readCount("site_h", "", hw),
      ipDay: readCount("ip_d", ip, dw),
      blocked: await this.isBlocked(ip),
    };
  }
}

let singleton: MemoryRateStorage | null = null;
export function getMemoryStorage(): MemoryRateStorage {
  if (!singleton) singleton = new MemoryRateStorage();
  return singleton;
}
