import { aliyunCheckDomain, aliyunConfigured } from "@/lib/domains/checkers/aliyun";
import { namecheapCheckBatch, namecheapConfigured } from "@/lib/domains/checkers/namecheap";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import type { DomainMarket } from "@/types/domain";

export type CheckDomainsProgress = { done: number; total: number; host: string };

/**
 * 单次 generate 内对阿里云的并发域名检测数。QPS 硬约束由 `rate-limit.ts` 的全局
 * 令牌桶在 **fetch 维度** 控制（8 tokens/s，贴近阿里云 10 QPS 硬限并留 20% 余量）。
 * 这里的并发数只是并行度上限，真正的 QPS 节奏由 fetch 级桶决定；即便设到 16 也
 * 不会突破 10 QPS，但过高并发只会让令牌队列更长、平均延迟变长且更容易在客户端
 * 断开时累积废请求，所以保持中等并发。
 */
const ALIYUN_CONCURRENCY = 6;

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onEach?: (result: R, item: T, index: number) => void | Promise<void>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx]!;
      const r = await worker(item, idx);
      results[idx] = r;
      if (onEach) await onEach(r, item, idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 真实域名检测。
 * - 已配置阿里云：全部域名走阿里云 CheckDomain（与万网一致）。
 * - 否则已配置 Namecheap：批量走 Namecheap API。
 * - 两者皆未配置：抛错，由上层返回 503。
 */
export async function checkDomainsRealtime(
  domains: string[],
  market: DomainMarket,
  opts?: {
    onCheckProgress?: (p: CheckDomainsProgress) => void | Promise<void>;
    /** 客户端断开等场景：不再领取令牌、不再发起新域名的检测（已在飞的请求会跑完）。 */
    signal?: AbortSignal;
  },
): Promise<Map<string, DomainCheckDetail>> {
  void market;
  const map = new Map<string, DomainCheckDetail>();
  const uniq = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return map;

  const nc = namecheapConfigured();
  const ali = aliyunConfigured();

  if (ali) {
    let done = 0;
    await runWithConcurrency(
      uniq,
      ALIYUN_CONCURRENCY,
      async (d) => {
        if (opts?.signal?.aborted) return null;
        // 令牌桶在 aliyun.ts 内的 `fetchCheckDomainBody` 里按「每次 HTTP 请求」取；
        // 这里只负责并行度，不再按域名粒度取令牌（否则会与 fetch 级桶叠加限速）。
        try {
          return await aliyunCheckDomain(d);
        } catch {
          // 单个域名耗尽所有重试后仍失败（限流 / 网络抖动）：整批继续、不让一条拖死
          // 40 条；失败已在 aliyun.ts 内部写入 ai-interactions.jsonl，此处静默跳过即可。
          // 调用方通过 `checks.get(d) === undefined` 判断跳过，与现有逻辑天然兼容。
          return null;
        }
      },
      async (detail, d) => {
        if (detail == null) return;
        map.set(d, detail);
        done += 1;
        await opts?.onCheckProgress?.({ done, total: uniq.length, host: d });
      },
    );
    return map;
  }

  if (nc) {
    let done = 0;
    for (let i = 0; i < uniq.length; i += 30) {
      if (opts?.signal?.aborted) break;
      const chunk = uniq.slice(i, i + 30);
      const batch = await namecheapCheckBatch(chunk);
      for (const d of chunk) {
        const hit = batch.get(d);
        if (!hit) {
          throw new Error(`Namecheap 未返回域名 ${d} 的检测结果，请检查 API 配置与配额。`);
        }
        map.set(d, hit);
        done += 1;
        await opts?.onCheckProgress?.({ done, total: uniq.length, host: d });
      }
    }
    return map;
  }

  throw new Error(
    "未配置域名检测：请设置 ALIYUN_ACCESS_KEY_ID 与 ALIYUN_ACCESS_KEY_SECRET（阿里云域名 CheckDomain），或配置 Namecheap API（NAMECHEAP_*）。已禁用模拟检测。",
  );
}
