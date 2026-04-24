import { aliyunCheckDomain, aliyunConfigured } from "@/lib/domains/checkers/aliyun";
import {
  cloudflareRegistrarCheckBatch,
  cloudflareRegistrarConfigured,
} from "@/lib/domains/checkers/cloudflare-registrar";
import { namecheapCheckBatch, namecheapConfigured } from "@/lib/domains/checkers/namecheap";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import type { DomainMarket } from "@/types/domain";
import { fetchBudgetHasRoom } from "@/lib/domains/fetch-budget";

export type CheckDomainsProgress = { done: number; total: number; host: string };

/**
 * 阿里云不出售（也无法询价）的 TLD。
 * 这些后缀即使 CF Registrar Phase 1 发现可用，也不会交给阿里云补 CNY 价格。
 */
const ALIYUN_UNSUPPORTED_TLDS = new Set([".io", ".ai", ".org", ".co", ".app", ".dev"]);

function getTld(domain: string): string {
  const idx = domain.indexOf(".");
  return idx >= 0 ? domain.slice(idx) : "";
}

/**
 * 阿里云 CNY 补价阶段：顺序执行，不并发，彻底避免限流。
 */
const ALIYUN_CONCURRENCY = 1;

/**
 * @deprecated 已由全局 fetch 追踪器（fetch-budget.ts）替代。
 * 保留此类仅为向后兼容。
 */
export class SubrequestBudget {
  hasRoom(_n = 1): boolean {
    return fetchBudgetHasRoom(_n);
  }
  spend(): void {
    // 追踪由 globalThis.fetch 钩子自动完成，此处无需手动计数
  }
  get remaining(): number {
    const s = (globalThis as Record<string, unknown>)._fetchBudgetSpent;
    return typeof s === "number" ? Math.max(0, 900 - s) : 9999;
  }
}

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
 *
 * 检测策略（两阶段）：
 *
 * Phase 1 — Cloudflare Registrar 批量检测（业务 API，非本站托管平台）
 *   单次最多 20 个 FQDN，返回可用性 + at-cost USD 注册价；大批量时轮数远少于逐域名请求。
 *
 * Phase 2 — 阿里云 CNY 价格补全（仅中文模式 + 阿里云已配置）
 *   对 Phase 1 可用且 TLD 受支持的域名补人民币价格等。
 *
 * 降级：仅阿里云 / 仅 Namecheap 等见代码分支。
 * `fetch-budget` 限制出站 fetch 总次数，避免与 AI 打分等争用。
 */
export async function checkDomainsRealtime(
  domains: string[],
  market: DomainMarket,
  opts?: {
    onCheckProgress?: (p: CheckDomainsProgress) => void | Promise<void>;
    signal?: AbortSignal;
    /** 当前语言："zh" → Phase 2 补阿里云 CNY 价格，其他 → 仅保留 GoDaddy USD 价格 */
    locale?: string;
    /**
     * @deprecated 已由全局 fetch 追踪器自动处理，传入值被忽略。
     * 保留此参数仅为向后兼容，避免修改所有调用方。
     */
    budget?: SubrequestBudget;
  },
): Promise<Map<string, DomainCheckDetail>> {
  void market;
  const map = new Map<string, DomainCheckDetail>();
  const uniq = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return map;

  const nc = namecheapConfigured();
  const ali = aliyunConfigured();
  const cf = cloudflareRegistrarConfigured();

  if (!ali && !nc && !cf) {
    throw new Error(
      "未配置域名检测：请设置 CF_REGISTRAR_TOKEN 与 CF_ACCOUNT_ID（Cloudflare），" +
        "或 ALIYUN_ACCESS_KEY_ID 与 ALIYUN_ACCESS_KEY_SECRET（阿里云），或配置 Namecheap API。",
    );
  }

  let done = 0;

  const notifyProgress = async (host: string) => {
    done += 1;
    await opts?.onCheckProgress?.({ done, total: uniq.length, host });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 主路径：Cloudflare Registrar API 可用时
  //   Phase 1：全量批量检测（20 域名/次，at-cost USD 定价）
  //   Phase 2：中文模式对可用域名补阿里云 CNY 价格
  //
  // subrequest 追踪由 fetch-budget.ts 的全局钩子自动完成，无需手动计数。
  // fetchBudgetHasRoom() 直接读取实际已发起的 fetch 次数，判断是否继续。
  // ════════════════════════════════════════════════════════════════════════════
  if (cf) {
    // ── Phase 1：Cloudflare 批量检测所有域名 ──────────────────────────────────
    const batchCount = Math.ceil(uniq.length / 20);
    if (fetchBudgetHasRoom(batchCount)) {
      const cfResults = await cloudflareRegistrarCheckBatch(uniq);
      for (const [d, detail] of cfResults) {
        map.set(d, detail);
        await notifyProgress(d);
      }
      // Cloudflare 未返回的域名（不支持的 TLD 等）补充为不可用
      for (const d of uniq) {
        if (!map.has(d)) {
          map.set(d, {
            domain: d,
            available: false,
            isPremium: false,
            price: 0,
            renewalPrice: 0,
            currency: "USD",
            source: "cloudflare",
            registrar: "cloudflare",
          });
          await notifyProgress(d);
        }
      }
    }

    // ── Phase 2：阿里云 CNY 补价（仅中文模式，仅可用 + 阿里云支持 TLD）────────
    // 每个域名最多 2 次 HTTP 请求（无重试）。
    // fetchBudgetHasRoom(1) 在每次请求前检查全局 fetch 计数，自然限制总量。
    if (ali && opts?.locale === "zh") {
      const toEnrich = [...map.entries()]
        .filter(([d, detail]) => detail.available && !ALIYUN_UNSUPPORTED_TLDS.has(getTld(d)))
        .map(([d]) => d);

      if (toEnrich.length > 0) {
        await runWithConcurrency(
          toEnrich,
          ALIYUN_CONCURRENCY,
          async (d) => {
            if (opts?.signal?.aborted) return null;
            if (!fetchBudgetHasRoom(1)) return null;
            try {
              return await aliyunCheckDomain(d, { currency: "CNY" });
            } catch {
              return null;
            }
          },
          (detail, d) => {
            if (detail == null) return;
            // 阿里云确认可用且有价格时，用 CNY 价格覆盖 Cloudflare USD 价格
            if (detail.available && detail.price > 0) {
              map.set(d, detail);
            }
          },
        );
      }
    }

    return map;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 降级路径 1：仅阿里云（CF Registrar 未配置）
  // ════════════════════════════════════════════════════════════════════════════
  if (ali) {
    const currency = opts?.locale === "zh" ? "CNY" : "USD";

    await runWithConcurrency(
      uniq,
      ALIYUN_CONCURRENCY,
      async (d) => {
        if (opts?.signal?.aborted) return null;
        if (!fetchBudgetHasRoom(1)) return null;
        try {
          return await aliyunCheckDomain(d, { currency });
        } catch {
          return null;
        }
      },
      async (detail, d) => {
        if (detail == null) return;
        map.set(d, detail);
        await notifyProgress(d);
      },
    );

    return map;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 降级路径 2：Namecheap（兜底）
  // ════════════════════════════════════════════════════════════════════════════
  if (nc) {
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
        await notifyProgress(d);
      }
    }
  }

  return map;
}
