import type { RegistrarId } from "@/types/domain";
import type { CheckSource } from "@/lib/domains/checkers/types";

/**
 * 默认万网云大使参数：未设置环境变量时仍带上推广关联（开源部署 fork 时亦生效）。
 * 自托管可设 ALIYUN_WANWANG_SOURCE / ALIYUN_WANWANG_USER_CODE 覆盖为自己的云大使信息。
 */
const DEFAULT_ALIYUN_WANWANG_PROMO = {
  source: "5176.29345612",
  userCode: "8rjzi3oo",
} as const;

function aliyunWanwangSearchUrl(fqdn: string): string {
  const source =
    process.env.ALIYUN_WANWANG_SOURCE?.trim() ||
    DEFAULT_ALIYUN_WANWANG_PROMO.source;
  const userCode =
    process.env.ALIYUN_WANWANG_USER_CODE?.trim() ||
    DEFAULT_ALIYUN_WANWANG_PROMO.userCode;
  const u = new URL("https://wanwang.aliyun.com/domain/searchresult/");
  u.searchParams.set("domain", fqdn.trim().toLowerCase());
  u.searchParams.set("source", source);
  u.searchParams.set("userCode", userCode);
  return u.toString();
}

/**
 * 检测结果来自 Cloudflare Registrar API 时，不提供 CF 注册按钮，默认映射为 GoDaddy 搜索链（与 USD 定价语境一致）。
 */
export function affiliateRegistrarFromCheckSource(source: CheckSource): RegistrarId {
  if (source === "cloudflare") return "godaddy";
  if (source === "godaddy") return "godaddy";
  return "aliyun";
}

export function buildAffiliateUrl(
  domain: string,
  registrar: RegistrarId,
): string {
  const d = encodeURIComponent(domain);
  if (registrar === "godaddy") {
    return `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}`;
  }
  return aliyunWanwangSearchUrl(domain);
}
