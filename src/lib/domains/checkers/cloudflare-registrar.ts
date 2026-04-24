/**
 * Cloudflare Registrar API（Beta，2026-04-15 发布）
 *
 * POST /client/v4/accounts/{accountId}/registrar/domain-check
 *   - 每次最多 20 个完整 FQDN
 *   - 返回 registrable（可注册）、tier（standard/premium）、
 *     pricing.registration_cost / renewal_cost（USD 字符串，at-cost 无加价）
 *   - 不支持的 TLD 返回 reason: "extension_not_supported_via_api"
 *
 * @see https://developers.cloudflare.com/registrar/registrar-api/
 */

import type { DomainCheckDetail } from "@/lib/domains/checkers/types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** 每批次最多 20 个（Cloudflare 文档限制） */
const BATCH_SIZE = 20;

interface CfDomainResult {
  name: string;
  registrable: boolean;
  tier?: "standard" | "premium";
  reason?: string;
  pricing?: {
    currency: string;
    registration_cost: string;
    renewal_cost: string;
  };
}

interface CfCheckResponse {
  success: boolean;
  result?: {
    domains: CfDomainResult[];
  };
  errors?: Array<{ code: number; message: string }>;
}

export function cloudflareRegistrarConfigured(): boolean {
  return Boolean(
    process.env.CF_REGISTRAR_TOKEN && process.env.CF_ACCOUNT_ID,
  );
}

/**
 * 批量检测域名可用性与注册/续费价格。
 *
 * @param domains  完整 FQDN 列表（小写）
 *
 * subrequest 计数由全局 fetch 钩子（fetch-budget.ts）自动完成，无需手动传回调。
 */
export async function cloudflareRegistrarCheckBatch(
  domains: string[],
): Promise<Map<string, DomainCheckDetail>> {
  const map = new Map<string, DomainCheckDetail>();
  if (!domains.length) return map;

  const token = process.env.CF_REGISTRAR_TOKEN!;
  const accountId = process.env.CF_ACCOUNT_ID!;
  const url = `${CF_API_BASE}/accounts/${accountId}/registrar/domain-check`;

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domains: batch }),
        cache: "no-store",
      });

      if (!res.ok) {
        console.error(
          "[cf-registrar] batch check HTTP",
          res.status,
          await res.text().catch(() => ""),
        );
        continue;
      }

      const data = (await res.json()) as CfCheckResponse;
      if (!data.success || !data.result?.domains) {
        console.error("[cf-registrar] unexpected response", JSON.stringify(data).slice(0, 200));
        continue;
      }

      for (const r of data.result.domains) {
        const fqdn = r.name.toLowerCase();
        const available = r.registrable === true;
        const isPremium = r.tier === "premium";

        const regPrice =
          available && r.pricing ? parseFloat(r.pricing.registration_cost) || 0 : 0;
        const renewPrice =
          available && r.pricing ? parseFloat(r.pricing.renewal_cost) || 0 : 0;

        map.set(fqdn, {
          domain: fqdn,
          available,
          isPremium: available && isPremium,
          price: available ? regPrice : 0,
          renewalPrice: available ? renewPrice : 0,
          currency: "USD",
          source: "cloudflare",
          registrar: "cloudflare",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // fetch 予算枯渇またはWorkers subrequest 上限 → ループを中断
      if (
        msg.includes("Subrequest budget exhausted") ||
        msg.includes("Too many subrequests")
      ) {
        console.warn("[cf-registrar] budget/subrequest limit hit, stopping batch loop");
        break;
      }
      console.error("[cf-registrar] batch check error:", msg);
    }
  }

  return map;
}
