import type { DomainMarket, RegistrarId } from "@/types/domain";

export type CheckSource = "namecheap" | "aliyun";

export type DomainCheckDetail = {
  domain: string;
  available: boolean;
  isPremium: boolean;
  price: number;
  renewalPrice: number;
  currency: "USD" | "CNY";
  source: CheckSource;
  registrar: RegistrarId;
};

export type CheckerEnv = {
  market: DomainMarket;
};
