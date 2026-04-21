import { USD_TO_CNY } from "@/lib/domains/currency-fx";

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = roundMoney(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, "");
}

/** 按首年价排序：统一折成「人民币等值」再比，避免列表里 CNY/USD 混排失真 */
export function registrationFirstYearSortKey(reg: {
  price: number;
  currency: "USD" | "CNY";
}): number {
  const p = reg.price > 0 ? reg.price : 0;
  if (reg.currency === "CNY") return p;
  return roundMoney(p * USD_TO_CNY);
}

/**
 * 列表价展示：中文界面优先人民币；数据为美元时原样显示美元并带说明；
 * 英文界面一律显示美元（人民币数据则换算）。
 */
export function formatRegistrationPriceLine(
  locale: string,
  registration: { price: number; renewalPrice: number; currency: "USD" | "CNY" },
  tierNote: string,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  const { price, renewalPrice, currency } = registration;
  const isZh = locale === "zh";

  if ((!Number.isFinite(price) || price <= 0) && (!Number.isFinite(renewalPrice) || renewalPrice <= 0)) {
    return t("priceLineUnknown");
  }

  if (isZh) {
    if (currency === "CNY") {
      return t("priceLineCny", {
        price: fmtAmount(price),
        renewal: fmtAmount(renewalPrice),
        tierNote,
      });
    }
    return t("priceLineUsdInZh", {
      price: fmtAmount(price),
      renewal: fmtAmount(renewalPrice),
      tierNote,
    });
  }

  const usdFirst =
    currency === "USD" ? price : roundMoney(price > 0 ? price / USD_TO_CNY : 0);
  const usdRenew =
    currency === "USD"
      ? renewalPrice
      : roundMoney(renewalPrice > 0 ? renewalPrice / USD_TO_CNY : 0);
  return t("priceLineUsdEn", {
    price: fmtAmount(usdFirst),
    renewal: fmtAmount(usdRenew),
    tierNote,
  });
}
