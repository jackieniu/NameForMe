import { protectRateOnly } from "@/lib/api-protection";
import { checkBodySchema } from "@/lib/domains/schemas";
import { checkDomainsRealtime } from "@/lib/domains/checkers/orchestrator";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";
import type { DomainMarket } from "@/types/domain";

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = checkBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid domain", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const denied = await protectRateOnly(req);
  if (denied) return denied;

  const domain = parsed.data.domain.toLowerCase();
  const market =
    raw && typeof raw === "object" && raw !== null && "market" in raw
      ? (raw as { market?: DomainMarket }).market
      : undefined;
  const safeMarket: DomainMarket =
    market === "cn" || market === "us" || market === "both" ? market : "both";

  let map: Map<string, DomainCheckDetail>;
  try {
    map = await checkDomainsRealtime([domain], safeMarket);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, available: false }, { status: 503 });
  }
  const det = map.get(domain);
  if (!det) {
    return Response.json(
      { error: "Check failed", available: false },
      { status: 502 },
    );
  }

  if (!det.available) {
    return Response.json({
      available: false,
      price: 0,
      renewalPrice: 0,
      currency: det.currency,
      source: det.source,
    });
  }

  return Response.json({
    available: true,
    price: det.price,
    renewalPrice: det.renewalPrice,
    currency: det.currency,
    tier: det.isPremium ? "premium" : "normal",
    premium: det.isPremium,
    source: det.source,
  });
}
