import type { DomainMarket } from "@/types/domain";

export type CheckSource = "aliyun" | "godaddy" | "cloudflare";

export type DomainCheckDetail = {
  domain: string;
  available: boolean;
  isPremium: boolean;
  price: number;
  renewalPrice: number;
  currency: "USD" | "CNY";
  source: CheckSource;
  /** 与 `source` 一致：检测结果来自哪家 API（含 Cloudflare Registrar，不等于用户点击的 Affiliate） */
  registrar: CheckSource;
  /**
   * Cloudflare Registrar `domain-check` 对该后缀返回不支持（如 `extension_not_supported_via_api`）。
   * 编排层应在配阿里云时改走 CheckDomain，勿把「不可用」当真。
   */
  cfExtensionUnsupportedViaApi?: boolean;
  /** 该 FQDN 在 CF 批次中无返回（HTTP/解析失败等），需依赖后续阿里云或其它来源 */
  cfBatchMiss?: boolean;
};

export type CheckerEnv = {
  market: DomainMarket;
};
