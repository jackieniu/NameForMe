/** Cloudflare 环境存储实现：KV 黑名单 + D1 原子计数。
 *
 * 设计要点：
 * - `incrementCounters` 使用单条 `INSERT ... ON CONFLICT DO UPDATE SET count=count+1 RETURNING count`
 *   语义原子，无「先查后写」的竞态。三个维度打包成 D1 batch（事务内执行）。
 * - 被拒请求也会消耗配额（返回值 > 阈值时上层拒绝 + 拉黑），攻击者无法精准把自己卡在阈值边缘。
 * - `blockIp` 直接 PUT 覆写 TTL；调用方保证先判 day 再判 hour（`rate-limit.ts`），
 *   同一 `tryConsumeApiSlot` 调用只写一次，跨请求并发最多出现一次 TTL 降级的瞬态
 *   race（下一次请求仍会被 D1 计数识别并重新上封），不会让攻击者长期绕过。
 * - 每次请求有极小概率触发旧窗口 DELETE 清理，避免表无限增长。
 */

import type { CloudflareBindings, D1Database, KVNamespace } from "./cf-bindings";
import {
  dayKey,
  hourKey,
  type RateCounts,
  type RateReadSnapshot,
  type RateStorage,
} from "./types";

const UPSERT_SQL = `
  INSERT INTO rate_counters (scope, key, window, count) VALUES (?, ?, ?, 1)
  ON CONFLICT (scope, key, window) DO UPDATE SET count = count + 1
  RETURNING count
`;

const SELECT_SQL = `
  SELECT count FROM rate_counters WHERE scope = ? AND key = ? AND window = ?
`;

export class CloudflareRateStorage implements RateStorage {
  constructor(private readonly kv: KVNamespace, private readonly db: D1Database) {}

  async isBlocked(ip: string): Promise<boolean> {
    if (!ip || ip === "unknown") return false;
    try {
      const v = await this.kv.get(`bl:${ip}`);
      return v != null;
    } catch {
      return false;
    }
  }

  async blockIp(ip: string, ttlSec: number): Promise<void> {
    if (!ip || ip === "unknown") return;
    const ttl = Math.max(60, Math.ceil(ttlSec));
    try {
      await this.kv.put(`bl:${ip}`, "1", { expirationTtl: ttl });
    } catch {
      // KV 写失败不影响主流程；本次请求已按 D1 计数判定，下一次请求会再次尝试。
    }
  }

  async incrementCounters(ip: string, now: Date): Promise<RateCounts> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    const results = await this.db.batch<{ count: number }>([
      this.db.prepare(UPSERT_SQL).bind("site_h", "", hw),
      this.db.prepare(UPSERT_SQL).bind("ip_h", ip, hw),
      this.db.prepare(UPSERT_SQL).bind("ip_d", ip, dw),
    ]);
    const siteHour = results[0]?.results?.[0]?.count;
    const ipHour = results[1]?.results?.[0]?.count;
    const ipDay = results[2]?.results?.[0]?.count;
    if (
      typeof siteHour !== "number" ||
      typeof ipHour !== "number" ||
      typeof ipDay !== "number"
    ) {
      throw new Error("D1 upsert returned malformed result");
    }

    if (Math.random() < 0.002) {
      void this.cleanupOldWindows(now).catch(() => {});
    }

    return { siteHour, ipHour, ipDay };
  }

  async readStatus(ip: string, now: Date): Promise<RateReadSnapshot> {
    const hw = hourKey(now);
    const dw = dayKey(now);
    const [s, ih, id, blocked] = await Promise.all([
      this.db.prepare(SELECT_SQL).bind("site_h", "", hw).first<{ count: number }>(),
      this.db.prepare(SELECT_SQL).bind("ip_h", ip, hw).first<{ count: number }>(),
      this.db.prepare(SELECT_SQL).bind("ip_d", ip, dw).first<{ count: number }>(),
      this.isBlocked(ip),
    ]);
    return {
      siteHour: s?.count ?? 0,
      ipHour: ih?.count ?? 0,
      ipDay: id?.count ?? 0,
      blocked,
    };
  }

  private async cleanupOldWindows(now: Date): Promise<void> {
    const oldHour = hourKey(new Date(now.getTime() - 25 * 3600_000));
    const oldDay = dayKey(new Date(now.getTime() - 3 * 86400_000));
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM rate_counters WHERE scope IN ('site_h', 'ip_h') AND window < ?`
        )
        .bind(oldHour),
      this.db
        .prepare(`DELETE FROM rate_counters WHERE scope = 'ip_d' AND window < ?`)
        .bind(oldDay),
    ]);
  }
}

/** 从当前运行环境（next-on-pages / opennext / wrangler）探测 Cloudflare 绑定。 */
export function getCloudflareBindings(): CloudflareBindings | null {
  const g = globalThis as Record<string | symbol, unknown>;

  const pickFrom = (ctx: unknown): CloudflareBindings | null => {
    if (!ctx || typeof ctx !== "object") return null;
    const env = (ctx as { env?: unknown }).env;
    if (!env || typeof env !== "object") return null;
    const e = env as Record<string, unknown>;
    if (e.BLOCKLIST && e.DB) {
      return { BLOCKLIST: e.BLOCKLIST as KVNamespace, DB: e.DB as D1Database };
    }
    return null;
  };

  const next1 = g[Symbol.for("__cloudflare-request-context__")];
  const picked1 = pickFrom(next1);
  if (picked1) return picked1;

  const next2 = g[Symbol.for("__cloudflare-context__")];
  const picked2 = pickFrom(next2);
  if (picked2) return picked2;

  const env = (g as { __env__?: unknown }).__env__;
  if (env && typeof env === "object") {
    const e = env as Record<string, unknown>;
    if (e.BLOCKLIST && e.DB) {
      return { BLOCKLIST: e.BLOCKLIST as KVNamespace, DB: e.DB as D1Database };
    }
  }

  return null;
}

export function tryCreateCloudflareStorage(): CloudflareRateStorage | null {
  const b = getCloudflareBindings();
  if (!b) return null;
  return new CloudflareRateStorage(b.BLOCKLIST, b.DB);
}
