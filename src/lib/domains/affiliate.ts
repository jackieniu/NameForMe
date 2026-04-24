import type { RegistrarId } from "@/types/domain";

export function buildAffiliateUrl(
  domain: string,
  registrar: RegistrarId,
): string {
  const d = encodeURIComponent(domain);
  if (registrar === "namecheap") {
    const aff = process.env.NAMECHEAP_AFFILIATE_ID;
    const base = `https://www.namecheap.com/domains/registration/results/?domain=${d}`;
    return aff ? `${base}&aff=${encodeURIComponent(aff)}` : base;
  }
  if (registrar === "godaddy") {
    return `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}`;
  }
  if (registrar === "cloudflare") {
    return `https://www.cloudflare.com/products/registrar/`;
  }
  const track = process.env.ALIYUN_DOMAIN_TRACK_ID;
  const base = `https://wanwang.aliyun.com/domain/searchresult/?domain=${d}`;
  return track ? `${base}&referrer=${encodeURIComponent(track)}` : base;
}
