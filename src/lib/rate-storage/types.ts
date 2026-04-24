/** 速率限制 / 黑名单后端存储抽象。
 *
 * 生产环境可配置 `UpstashRateStorage`（Redis）；未配置时回退到 `MemoryRateStorage`。
 */

export type RateCounts = {
  /** 当前小时全站累计调用数 */
  siteHour: number;
  /** 当前 IP 今日累计调用数 */
  ipDay: number;
};

export type RateReadSnapshot = RateCounts & {
  blocked: boolean;
};


export interface RateStorage {
  /** 查询 IP 是否在黑名单中（TTL 期内即视为生效）。 */
  isBlocked(ip: string): Promise<boolean>;

  /** 将 IP 加入黑名单，`ttlSec` 秒后自动过期。 */
  blockIp(ip: string, ttlSec: number): Promise<void>;

  /**
   * 原子地对 site_h / ip_h / ip_d 三个计数器各 +1 并返回新值。
   *
   * **注意**：本次调用也计入新值；上层应在返回值 > 阈值时拒绝请求并拉黑 IP。
   * 这样被拒的请求也占配额，攻击者无法靠狂刷保持「处于阈值边缘」。
   */
  incrementCounters(ip: string, now: Date): Promise<RateCounts>;

  /** 只读快照；不增加计数。 */
  readStatus(ip: string, now: Date): Promise<RateReadSnapshot>;
}

export function hourKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  const h = `${d.getUTCHours()}`.padStart(2, "0");
  return `${y}${m}${day}${h}`;
}

export function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 到下一个整点的秒数（至少 60）。 */
export function secondsToNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(now.getUTCHours() + 1);
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** 到下一个 UTC 自然日 0 点的秒数（至少 60）。 */
export function secondsToNextDay(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}
