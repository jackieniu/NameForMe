/**
 * Porkbun 公开价目：`POST /pricing/get` 无需 API Key（官方 OpenAPI `security: []`）。
 * 用于阿里云 CheckDomain 不提供 StaticPriceInfo 价的 TLD（如 `.ai`）的参考零售价（USD）。
 *
 * @see https://porkbun.com/api/json/v3/spec — `paths["/pricing/get"]`
 */

const PORKBUN_PRICING_URL = "https://api.porkbun.com/api/json/v3/pricing/get";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type RetailUsd = { registration: number; renewal: number };

type CacheBucket = { at: number; map: Map<string, RetailUsd | null> };

const globalAny = globalThis as unknown as {
  __nfm_porkbun_pricing_cache?: CacheBucket;
  __nfm_porkbun_pricing_pending?: Map<string, Promise<RetailUsd | null>>;
};

function cacheBucket(): CacheBucket {
  if (!globalAny.__nfm_porkbun_pricing_cache) {
    globalAny.__nfm_porkbun_pricing_cache = { at: 0, map: new Map() };
  }
  return globalAny.__nfm_porkbun_pricing_cache;
}

function pendingMap(): Map<string, Promise<RetailUsd | null>> {
  if (!globalAny.__nfm_porkbun_pricing_pending) {
    globalAny.__nfm_porkbun_pricing_pending = new Map();
  }
  return globalAny.__nfm_porkbun_pricing_pending;
}

function normalizeTld(tld: string): string {
  return tld.replace(/^\./, "").trim().toLowerCase();
}

function parseUsdRow(row: unknown): RetailUsd | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const reg = Number.parseFloat(String(o.registration ?? o.Registration ?? "0"));
  const ren = Number.parseFloat(String(o.renewal ?? o.Renewal ?? "0"));
  const registration = Number.isFinite(reg) && reg > 0 ? reg : 0;
  const renewal = Number.isFinite(ren) && ren > 0 ? ren : 0;
  if (registration <= 0 && renewal <= 0) return null;
  return {
    registration: registration > 0 ? registration : renewal,
    renewal: renewal > 0 ? renewal : registration,
  };
}

async function fetchTldRetailUsd(tldKey: string): Promise<RetailUsd | null> {
  const res = await fetch(PORKBUN_PRICING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tlds: [tldKey] }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  if (String(root.status ?? "").toUpperCase() !== "SUCCESS") return null;
  const pricing = root.pricing;
  if (!pricing || typeof pricing !== "object") return null;
  return parseUsdRow((pricing as Record<string, unknown>)[tldKey]);
}

/**
 * 返回 Porkbun 标价（USD）：新购 registration、续费 renewal；失败或未上架返回 null。
 * 进程内缓存 + 同 TLD 并发合并为单次请求。
 */
export async function getPorkbunTldRetailUsd(tld: string): Promise<RetailUsd | null> {
  const key = normalizeTld(tld);
  if (!key) return null;

  const bucket = cacheBucket();
  const now = Date.now();
  if (now - bucket.at < CACHE_TTL_MS && bucket.map.has(key)) {
    return bucket.map.get(key) ?? null;
  }

  const pend = pendingMap();
  let p = pend.get(key);
  if (!p) {
    p = fetchTldRetailUsd(key).then((retail) => {
      bucket.at = Date.now();
      bucket.map.set(key, retail);
      return retail;
    });
    pend.set(key, p);
    p.finally(() => pend.delete(key));
  }
  return p;
}
