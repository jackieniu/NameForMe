import { aliyunCheckDomain, aliyunConfigured } from "@/lib/domains/checkers/aliyun";
import {
  cloudflareRegistrarCheckBatch,
  cloudflareRegistrarConfigured,
} from "@/lib/domains/checkers/cloudflare-registrar";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import { logDomainCheckRoute } from "@/lib/ai-logger";
import type { DomainMarket } from "@/types/domain";

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
 * Phase 1 — Cloudflare Registrar 批量（不含 `.cn`；单次 POST 最多 20 个 FQDN）
 *
 * Phase 1b — `.cn` + CF 失败项（无返回 / extension_not_supported）统一走阿里云 CheckDomain；
 *   TLD 属于 `ALIYUN_UNSUPPORTED_TLDS` 的不送阿里云。
 *
 * Phase 2 — 阿里云 CNY 补价（仅中文 + 已配阿里云）对 CF 已可用且仍缺万网 CNY 的域名。
 *
 * 降级：仅配阿里云时，全程对 uniq 中域名逐域 CheckDomain，无 Cloudflare 批量阶段。
 */
export async function checkDomainsRealtime(
  domains: string[],
  market: DomainMarket,
  opts?: {
    onCheckProgress?: (p: CheckDomainsProgress) => void | Promise<void>;
    signal?: AbortSignal;
    /** 当前语言："zh" → Phase 2 补阿里云 CNY 价格，其他 → 仅保留 GoDaddy USD 价格 */
    locale?: string;
    /** 与 `ai-interactions.jsonl` 中 `type: domain_check_route` / `generate_stream` 关联 */
    checkLogContext?: { sessionId?: string };
  },
): Promise<Map<string, DomainCheckDetail>> {
  void market;
  const map = new Map<string, DomainCheckDetail>();
  const uniq = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return map;

  const ali = aliyunConfigured();
  const cf = cloudflareRegistrarConfigured();
  const logSid = opts?.checkLogContext?.sessionId;

  if (!ali && !cf) {
    throw new Error(
      "未配置域名检测：请设置 CF_REGISTRAR_TOKEN 与 CF_ACCOUNT_ID（Cloudflare Registrar），" +
        "或 ALIYUN_ACCESS_KEY_ID 与 ALIYUN_ACCESS_KEY_SECRET（阿里云）。",
    );
  }

  let cfPhaseDone = 0;

  const notifyCfProgress = async (host: string, cfTotal: number) => {
    cfPhaseDone += 1;
    await opts?.onCheckProgress?.({
      done: cfPhaseDone,
      total: Math.max(cfTotal, 1),
      host,
    });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 主路径：Cloudflare Registrar API 可用时
  //   Phase 1：批量检测（排除 .cn）
  //   Phase 1b：.cn + CF 失败项 → 阿里云（跳过阿里云不支持的 TLD）
  //   Phase 2：中文下 CF 可用域名的万网 CNY 补价
  // ════════════════════════════════════════════════════════════════════════════
  if (cf) {
    const forCf = uniq.filter((d) => getTld(d) !== ".cn");
    const cnOnly = uniq.filter((d) => getTld(d) === ".cn");

    const batchCount = Math.ceil(forCf.length / 20) || 0;
    logDomainCheckRoute({
      sessionId: logSid,
      step: "cf_phase1",
      uniqueFqdnCount: forCf.length,
      summary:
        "Cloudflare Registrar 批量：不含 .cn；单次 POST 最多 20 个 FQDN；.cn 与 CF 无返回/extension_not_supported 的域名随后走阿里云（阿里云不支持的 TLD 除外）。",
      cloudflare: {
        mode: "batch",
        maxDomainsPerRequest: 20,
        method: "POST",
        baseUrl: "https://api.cloudflare.com/client/v4",
        pathPattern: "/accounts/{accountId}/registrar/domain-check",
        httpBatchRequestCount: batchCount,
      },
    });

    const cfReturned =
      forCf.length > 0 ? await cloudflareRegistrarCheckBatch(forCf) : new Map<string, DomainCheckDetail>();

    for (const d of forCf) {
      if (cfReturned.has(d)) {
        map.set(d, cfReturned.get(d)!);
      } else {
        map.set(d, {
          domain: d,
          available: false,
          isPremium: false,
          price: 0,
          renewalPrice: 0,
          currency: "USD",
          source: "cloudflare",
          registrar: "cloudflare",
          cfBatchMiss: true,
        });
      }
      await notifyCfProgress(d, forCf.length);
    }

    if (!ali && cnOnly.length > 0) {
      for (const d of cnOnly) {
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
      }
    }

    const phase1Total = forCf.length;
    const currencyPostCf = opts?.locale === "zh" ? "CNY" : "USD";

    const aliRecheckList: string[] = [];
    if (ali) {
      for (const d of cnOnly) {
        if (!ALIYUN_UNSUPPORTED_TLDS.has(getTld(d))) aliRecheckList.push(d);
      }
      for (const d of forCf) {
        if (ALIYUN_UNSUPPORTED_TLDS.has(getTld(d))) continue;
        const det = map.get(d);
        if (!det) continue;
        if (det.cfExtensionUnsupportedViaApi || det.cfBatchMiss) aliRecheckList.push(d);
      }
    }

    const aliRecheckDeduped = [...new Set(aliRecheckList)];
    const aliRecheckSet = new Set(aliRecheckDeduped);

    if (aliRecheckDeduped.length > 0) {
      logDomainCheckRoute({
        sessionId: logSid,
        step: "aliyun_cf_fallback",
        uniqueFqdnCount: aliRecheckDeduped.length,
        summary:
          "CF 阶段后统一阿里云：.cn、CF 批次无返回、或 extension_not_supported；已排除阿里云不支持的 TLD。",
        aliyun: {
          mode: "per_domain",
          method: "GET",
          host: "domain.aliyuncs.com",
          action: "CheckDomain",
          concurrency: 1,
          httpCallsPerDomain: "1~2",
          targetFqdnCount: aliRecheckDeduped.length,
        },
      });
    }

    const toEnrich =
      ali && opts?.locale === "zh"
        ? [...map.entries()]
            .filter(([d, detail]) => {
              if (aliRecheckSet.has(d)) return false;
              if (!detail.available) return false;
              if (ALIYUN_UNSUPPORTED_TLDS.has(getTld(d))) return false;
              if (detail.source === "aliyun" && detail.currency === "CNY") return false;
              return true;
            })
            .map(([d]) => d)
        : [];

    const postTotalSteps = aliRecheckDeduped.length + toEnrich.length;
    if (postTotalSteps > 0 && ali) {
      let postDone = 0;
      const bumpPostCf = async (host: string) => {
        postDone += 1;
        await opts?.onCheckProgress?.({
          done: phase1Total + postDone,
          total: phase1Total + postTotalSteps,
          host,
        });
      };

      if (toEnrich.length > 0) {
        logDomainCheckRoute({
          sessionId: logSid,
          step: "aliyun_enrich",
          uniqueFqdnCount: toEnrich.length,
          summary:
            "阿里云万网补价：对 CF 已标可用且 TLD 可售的 FQDN 逐域 CheckDomain（GET domain.aliyuncs.com，串行 1 域名/步，每域名 1～2 次请求）；非 CF 式批量。",
          aliyun: {
            mode: "per_domain",
            method: "GET",
            host: "domain.aliyuncs.com",
            action: "CheckDomain",
            concurrency: 1,
            httpCallsPerDomain: "1~2",
            targetFqdnCount: toEnrich.length,
          },
        });
      }

      await runWithConcurrency(
        [...aliRecheckDeduped, ...toEnrich],
        ALIYUN_CONCURRENCY,
        async (d) => {
          if (opts?.signal?.aborted) return null;
          try {
            if (aliRecheckSet.has(d)) {
              return await aliyunCheckDomain(d, { currency: currencyPostCf });
            }
            return await aliyunCheckDomain(d, { currency: "CNY" });
          } catch {
            return null;
          }
        },
        async (detail, d) => {
          if (aliRecheckSet.has(d)) {
            if (detail) map.set(d, detail);
          } else if (detail && detail.available && detail.price > 0) {
            map.set(d, detail);
          }
          await bumpPostCf(d);
        },
      );
    }

    return map;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 降级路径 1：仅阿里云（CF Registrar 未配置）
  // ════════════════════════════════════════════════════════════════════════════
  if (ali) {
    let onlyAliDone = 0;
    const notifyAliOnlyProgress = async (host: string) => {
      onlyAliDone += 1;
      await opts?.onCheckProgress?.({
        done: onlyAliDone,
        total: Math.max(uniq.length, 1),
        host,
      });
    };

    const currency = opts?.locale === "zh" ? "CNY" : "USD";

    logDomainCheckRoute({
      sessionId: logSid,
      step: "aliyun_only",
      uniqueFqdnCount: uniq.length,
      summary:
        "未配置 Cloudflare Registrar：全程仅阿里云 CheckDomain，逐域 GET、串行 1 域名/步；无 CF 批量阶段。",
      aliyun: {
        mode: "per_domain",
        method: "GET",
        host: "domain.aliyuncs.com",
        action: "CheckDomain",
        concurrency: 1,
        httpCallsPerDomain: "1~2",
        targetFqdnCount: uniq.length,
      },
    });

    await runWithConcurrency(
      uniq,
      ALIYUN_CONCURRENCY,
      async (d) => {
        if (opts?.signal?.aborted) return null;
        try {
          return await aliyunCheckDomain(d, { currency });
        } catch {
          return null;
        }
      },
      async (detail, d) => {
        if (detail == null) return;
        map.set(d, detail);
        await notifyAliOnlyProgress(d);
      },
    );

    return map;
  }

  return map;
}
