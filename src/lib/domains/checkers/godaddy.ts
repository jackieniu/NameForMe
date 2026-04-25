/**
 * GoDaddy Domains API v1
 * 批量检测域名可用性与注册价格（含溢价域名真实价）。
 *
 * 端点：POST /v1/domains/available
 *   - 单次最多 500 个域名
 *   - 返回 available、price（micro-USD，÷1,000,000 得美元）、currency、period
 *
 * @see https://developer.godaddy.com/doc/endpoint/domains#/v1/domainAvailableBulk
 */

import { getPorkbunTldRetailUsd } from "@/lib/domains/checkers/porkbun-pricing";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";

const GODADDY_API_BASE = "https://api.godaddy.com/v1";

/** 单次批量最多 500 个（GoDaddy 文档限制） */
const BATCH_SIZE = 500;

/** GoDaddy 批量接口返回的单条结构 */
interface GdDomainResult {
  domain: string;
  available: boolean;
  definitive?: boolean;
  price?: number; // micro-USD（÷1,000,000 = USD）
  currency?: string;
  period?: number;
}

export function godaddyConfigured(): boolean {
  return Boolean(process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET);
}

function authHeader(): string {
  return `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`;
}

function microToUsd(micro: number): number {
  return Math.round((micro / 1_000_000) * 100) / 100;
}

/**
 * 批量检测域名。
 * @param onFetch 每发起一次 HTTP 批量请求前回调（可选，用于可观测性）
 */
export async function godaddyCheckBatch(
  domains: string[],
  onFetch?: () => void,
): Promise<Map<string, DomainCheckDetail>> {
  const map = new Map<string, DomainCheckDetail>();
  if (!domains.length) return map;

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);
    onFetch?.();
    try {
      const res = await fetch(`${GODADDY_API_BASE}/domains/available?checkType=FAST`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[godaddy] bulk check HTTP", res.status, await res.text().catch(() => ""));
        continue;
      }

      // 响应可能是数组，也可能是 { domains: [...] }
      const raw: unknown = await res.json();
      const results: GdDomainResult[] = Array.isArray(raw)
        ? (raw as GdDomainResult[])
        : ((raw as { domains?: GdDomainResult[] }).domains ?? []);

      // 收集本批次中出现的所有唯一 TLD，批量获取 Porkbun 续费参考价
      const tldSet = new Set(
        results.map((r) => {
          const idx = r.domain.indexOf(".");
          return idx >= 0 ? r.domain.slice(idx + 1) : "";
        }),
      );
      const porkbunRenewMap = new Map<string, number>();
      await Promise.all(
        [...tldSet].filter(Boolean).map(async (tld) => {
          const pb = await getPorkbunTldRetailUsd(tld);
          if (pb && pb.renewal > 0) porkbunRenewMap.set(tld, pb.renewal);
        }),
      );

      for (const r of results) {
        const fqdn = r.domain.toLowerCase();
        const available = r.available === true;
        const regUsd = r.price && r.price > 0 ? microToUsd(r.price) : 0;

        // 续费价优先用 Porkbun TLD 标准价（续费通常不打折），其次估算为注册价
        const tldKey = fqdn.slice(fqdn.indexOf(".") + 1);
        const renewUsd =
          porkbunRenewMap.get(tldKey) ??
          (regUsd > 0 ? Math.round(regUsd * 1.05 * 100) / 100 : 0);

        // 溢价判断：高于 Porkbun 标准价 1.5 倍视为溢价
        const pbReg = porkbunRenewMap.get(tldKey);
        const isPremium = pbReg != null && regUsd > 0 ? regUsd > pbReg * 1.5 : false;

        map.set(fqdn, {
          domain: fqdn,
          available,
          isPremium: available && isPremium,
          price: available ? regUsd : 0,
          renewalPrice: available ? renewUsd : 0,
          currency: "USD",
          source: "godaddy",
          registrar: "godaddy",
        });
      }
    } catch (err) {
      console.error("[godaddy] bulk check error:", err instanceof Error ? err.message : String(err));
    }
  }

  return map;
}
