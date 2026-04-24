/**
 * Upstash Redis 存储实现：REST API 黑名单 + 原子计数。
 *
 * 设计要点：
 * - `incrementCounters` 用 Redis pipeline 批量执行 INCR + EXPIREAT，减少 RTT。
 * - EXPIREAT 每次都写（幂等），同一窗口内所有请求写的是同一个过期时间戳。
 * - 黑名单用 SET key 1 EX ttl；isBlocked 单次 GET。
 * - 环境变量：UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN（Upstash 控制台复制）。
 */

import { Redis } from "@upstash/redis";
import {
  dayKey,
  hourKey,
  type RateCounts,
  type RateReadSnapshot,
  type RateStorage,
} from "./types";

export function hasUpstashRateLimitBindings(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

export class UpstashRateStorage implements RateStorage {
  private redis: Redis;

  constructor() {
    this.redis = Redis.fromEnv();
  }

  async isBlocked(ip: string): Promise<boolean> {
    if (!ip || ip === "unknown") return false;
    try {
      const v = await this.redis.get(`bl:${ip}`);
      return v != null;
    } catch {
      return false;
    }
  }

  async blockIp(ip: string, ttlSec: number): Promise<void> {
    if (!ip || ip === "unknown") return;
    const ttl = Math.max(60, Math.ceil(ttlSec));
    try {
      await this.redis.set(`bl:${ip}`, "1", { ex: ttl });
    } catch {
      // 写失败不影响主流程；下一次请求仍会被计数器识别
    }
  }

  async incrementCounters(ip: string, now: Date): Promise<RateCounts> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    const siteKey = `site_h:${hw}`;
    const ipKey = `ip_d:${ip}:${dw}`;

    // 过期时间：当前小时末 + 1h 缓冲 / 当前自然日末 + 1h 缓冲
    const hourExpiry = new Date(now);
    hourExpiry.setUTCMinutes(0, 0, 0);
    hourExpiry.setUTCHours(hourExpiry.getUTCHours() + 2);

    const dayExpiry = new Date(now);
    dayExpiry.setUTCHours(25, 0, 0, 0);

    const pipe = this.redis.pipeline();
    pipe.incr(siteKey);
    pipe.incr(ipKey);
    pipe.expireat(siteKey, Math.floor(hourExpiry.getTime() / 1000));
    pipe.expireat(ipKey, Math.floor(dayExpiry.getTime() / 1000));

    const results = await pipe.exec();
    const siteHour = results[0] as number;
    const ipDay = results[1] as number;

    if (typeof siteHour !== "number" || typeof ipDay !== "number") {
      throw new Error("Upstash INCR returned non-number");
    }

    return { siteHour, ipDay };
  }

  async readStatus(ip: string, now: Date): Promise<RateReadSnapshot> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    const [s, id, blocked] = await Promise.all([
      this.redis.get<number>(`site_h:${hw}`),
      this.redis.get<number>(`ip_d:${ip}:${dw}`),
      this.isBlocked(ip),
    ]);
    return {
      siteHour: s ?? 0,
      ipDay: id ?? 0,
      blocked,
    };
  }
}
