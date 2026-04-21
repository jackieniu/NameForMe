import { XMLParser } from "fast-xml-parser";
import type { DomainCheckDetail } from "@/lib/domains/checkers/types";

type ParsedRow = {
  "@_Domain"?: string;
  "@_Available"?: string;
  "@_IsPremiumName"?: string;
  "@_IsPremium"?: string;
  "@_PremiumRegistrationPrice"?: string;
  "@_PremiumRenewalPrice"?: string;
};

function namecheapBaseUrl() {
  return process.env.NAMECHEAP_USE_SANDBOX === "1"
    ? "https://api.sandbox.namecheap.com/xml.response"
    : "https://api.namecheap.com/xml.response";
}

function parseMoney(s: string | undefined): number {
  if (!s) return 12.99;
  const n = Number.parseFloat(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 12.99;
}

export function namecheapConfigured(): boolean {
  return Boolean(
    process.env.NAMECHEAP_API_USER &&
      process.env.NAMECHEAP_API_KEY &&
      process.env.NAMECHEAP_CLIENT_IP,
  );
}

/** Batch check up to ~30 domains per request (comma-separated DomainList). */
export async function namecheapCheckBatch(
  domains: string[],
): Promise<Map<string, DomainCheckDetail>> {
  const out = new Map<string, DomainCheckDetail>();
  const apiUser = process.env.NAMECHEAP_API_USER!;
  const apiKey = process.env.NAMECHEAP_API_KEY!;
  const userName = process.env.NAMECHEAP_USERNAME ?? apiUser;
  const clientIp = process.env.NAMECHEAP_CLIENT_IP!;
  const list = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return out;

  const url = new URL(namecheapBaseUrl());
  url.searchParams.set("ApiUser", apiUser);
  url.searchParams.set("ApiKey", apiKey);
  url.searchParams.set("UserName", userName);
  url.searchParams.set("ClientIp", clientIp);
  url.searchParams.set("Command", "namecheap.domains.check");
  url.searchParams.set("DomainList", list.join(","));

  const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Namecheap HTTP ${res.status}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const data = parser.parse(text) as Record<string, unknown>;
  const api = data.ApiResponse as Record<string, unknown> | undefined;
  const status = String(api?.["@_Status"] ?? "");
  if (status !== "OK") {
    const err = api?.Errors as Record<string, unknown> | string | undefined;
    throw new Error(`Namecheap API ${status}: ${JSON.stringify(err)}`);
  }

  const cmd = api?.CommandResponse as Record<string, unknown> | undefined;
  const raw = cmd?.DomainCheckResult as ParsedRow | ParsedRow[] | undefined;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];

  for (const row of rows) {
    const domain = String(row["@_Domain"] ?? "").toLowerCase();
    if (!domain) continue;
    const available = String(row["@_Available"] ?? "").toLowerCase() === "true";
    const isPremium =
      String(row["@_IsPremiumName"] ?? row["@_IsPremium"] ?? "")
        .toLowerCase() === "true";
    const price = parseMoney(row["@_PremiumRegistrationPrice"]);
    const renewal = parseMoney(row["@_PremiumRenewalPrice"] || row["@_PremiumRegistrationPrice"]);
    out.set(domain, {
      domain,
      available,
      isPremium: isPremium && available,
      price: isPremium && available ? price : available ? 12.99 : 0,
      renewalPrice: isPremium && available ? renewal : available ? 15.58 : 0,
      currency: "USD",
      source: "namecheap",
      registrar: "namecheap",
    });
  }

  if (out.size === 0) {
    const re = /<DomainCheckResult\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const tag = m[0] ?? "";
      const domain = /Domain="([^"]+)"/i.exec(tag)?.[1]?.toLowerCase();
      if (!domain) continue;
      const av = /Available="(true|false)"/i.exec(tag)?.[1]?.toLowerCase() === "true";
      const prem =
        /IsPremiumName="(true|false)"/i.exec(tag)?.[1]?.toLowerCase() === "true" ||
        /IsPremium="(true|false)"/i.exec(tag)?.[1]?.toLowerCase() === "true";
      const pr = /PremiumRegistrationPrice="([^"]+)"/i.exec(tag)?.[1];
      const ren = /PremiumRenewalPrice="([^"]+)"/i.exec(tag)?.[1];
      const price = parseMoney(pr);
      const renewal = parseMoney(ren || pr);
      out.set(domain, {
        domain,
        available: av,
        isPremium: prem && av,
        price: prem && av ? price : av ? 12.99 : 0,
        renewalPrice: prem && av ? renewal : av ? 15.58 : 0,
        currency: "USD",
        source: "namecheap",
        registrar: "namecheap",
      });
    }
  }

  return out;
}
