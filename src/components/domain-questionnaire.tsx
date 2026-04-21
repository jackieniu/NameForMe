"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type {
  BudgetCurrency,
  DomainMarket,
  DomainRequirements,
  DomainTone,
  MaxFirstYearBudgetCny,
  MaxFirstYearBudgetUsd,
} from "@/types/domain";
import type { HomeScenarioReadonlyKey } from "@/lib/home-scenario";

/** 受欢迎程度大致从高到低（全球 + 中文站常用） */
const SUFFIX_OPTIONS = [
  ".com",
  ".io",
  ".ai",
  ".net",
  ".org",
  ".co",
  ".app",
  ".dev",
  ".tech",
  ".online",
  ".site",
  ".shop",
  ".store",
  ".xyz",
  ".me",
  ".info",
  ".cloud",
  ".cn",
] as const;

const BUDGET_TIERS_CNY: MaxFirstYearBudgetCny[] = [
  100,
  1000,
  10000,
  100000,
  0,
];

const BUDGET_TIERS_USD: MaxFirstYearBudgetUsd[] = [10, 100, 1000, 10000, 0];

function wizardBudgetTierLabel(
  currency: BudgetCurrency,
  tier: number,
  t: (key: string) => string,
): string {
  if (tier === 0) return t("budgetTier_unlimited");
  if (currency === "CNY") {
    switch (tier) {
      case 100:
        return t("budgetTier_100");
      case 1000:
        return t("budgetTier_1000");
      case 10000:
        return t("budgetTier_10000");
      case 100000:
        return t("budgetTier_100000");
      default:
        return t("budgetTier_unlimited");
    }
  }
  switch (tier) {
    case 10:
      return t("budgetTierUsd_10");
    case 100:
      return t("budgetTierUsd_100");
    case 1000:
      return t("budgetTierUsd_1000");
    case 10000:
      return t("budgetTierUsd_10000");
    default:
      return t("budgetTier_unlimited");
  }
}

type Props = {
  initialDescription: string;
  /** 首页四类场景卡片（非「其他」）：问卷顶部只读展示产品类型，不写入描述框 */
  initialHomeScenarioKey?: HomeScenarioReadonlyKey;
  onComplete: (req: DomainRequirements) => void;
};

function capitalizeScenarioKey(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function DomainQuestionnaire({
  initialDescription,
  initialHomeScenarioKey,
  onComplete,
}: Props) {
  const t = useTranslations("Wizard");
  const tHome = useTranslations("Home");
  const locale = useLocale();
  const isZh = locale === "zh";
  const budgetCurrency: BudgetCurrency = isZh ? "CNY" : "USD";
  const budgetTiers =
    budgetCurrency === "CNY" ? BUDGET_TIERS_CNY : BUDGET_TIERS_USD;

  const [description, setDescription] = useState(initialDescription);
  /** 中文默认：侧重国内、.com+.cn、¥100；英文默认：全球/海外、.com+.net、$100（均与产品截图一致） */
  const [market, setMarket] = useState<DomainMarket>(() => (isZh ? "cn" : "us"));
  const [tone, setTone] = useState<DomainTone>("any");
  const [maxFirstYearBudgetAmount, setMaxFirstYearBudgetAmount] = useState<number>(() => 100);
  const [suffixes, setSuffixes] = useState<string[]>(() =>
    isZh ? [".com", ".cn"] : [".com", ".net"],
  );

  useEffect(() => {
    setDescription(initialDescription);
  }, [initialDescription]);

  useEffect(() => {
    setMaxFirstYearBudgetAmount((prev) => {
      if (budgetCurrency === "CNY") {
        return BUDGET_TIERS_CNY.includes(prev as MaxFirstYearBudgetCny)
          ? prev
          : 100;
      }
      return BUDGET_TIERS_USD.includes(prev as MaxFirstYearBudgetUsd) ? prev : 100;
    });
  }, [budgetCurrency]);

  const defaultSuffixes = useMemo(
    () => (isZh ? [".com", ".cn"] : [".com", ".net"]),
    [isZh],
  );

  function toggleSuffix(s: string) {
    setSuffixes((prev) => {
      const has = prev.includes(s);
      const next = has ? prev.filter((x) => x !== s) : [...prev, s];
      return next.length ? next : defaultSuffixes;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = description.trim();
    const desc = trimmed || t("emptyDescriptionFallback");
    const homeScenarioLabel = initialHomeScenarioKey
      ? tHome(`scenario${capitalizeScenarioKey(initialHomeScenarioKey)}`)
      : undefined;
    const base = {
      description: desc.slice(0, 4000),
      ...(homeScenarioLabel ? { homeScenarioLabel } : {}),
      market,
      tone,
      syllable: "any" as const,
      suffixes: suffixes.length ? suffixes : [...defaultSuffixes],
      excludes: [] as string[],
    };
    onComplete(
      budgetCurrency === "CNY"
        ? {
            ...base,
            budgetCurrency: "CNY",
            maxFirstYearBudgetAmount: maxFirstYearBudgetAmount as MaxFirstYearBudgetCny,
          }
        : {
            ...base,
            budgetCurrency: "USD",
            maxFirstYearBudgetAmount: maxFirstYearBudgetAmount as MaxFirstYearBudgetUsd,
          },
    );
  }

  const homeScenarioDisplay =
    initialHomeScenarioKey != null
      ? tHome(`scenario${capitalizeScenarioKey(initialHomeScenarioKey)}`)
      : null;

  return (
    <form
      onSubmit={submit}
      className="space-y-6 rounded-2xl border border-[var(--border)] bg-white p-5 shadow-sm sm:p-6"
    >
      {homeScenarioDisplay ? (
        <p className="text-sm text-[var(--foreground)]">
          <span className="font-semibold">{t("productType")}{isZh ? "：" : ": "}</span>
          {homeScenarioDisplay}
        </p>
      ) : null}

      <label className="block">
        <span className="text-sm font-semibold text-[var(--foreground)]">{t("description")}</span>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--muted)]">{t("descriptionHint")}</p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2 w-full resize-y rounded-xl border border-[var(--border)] bg-background px-3 py-2 text-sm outline-none focus:border-[var(--border-hover)] focus:ring-2 focus:ring-brand/20"
          required={!initialHomeScenarioKey}
        />
      </label>

      <fieldset>
        <legend className="text-sm font-semibold text-[var(--foreground)]">{t("market")}</legend>
        <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{t("marketHint")}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {(
            [
              ["cn", t("market_cn")],
              ["us", t("market_us")],
              ["both", t("market_both")],
            ] as const
          ).map(([v, label]) => (
            <label
              key={v}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <input
                type="radio"
                name="market"
                value={v}
                checked={market === v}
                onChange={() => setMarket(v)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-[var(--foreground)]">{t("tone")}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["any", "tone_any"],
              ["professional", "tone_professional"],
              ["playful", "tone_playful"],
              ["tech", "tone_tech"],
              ["elegant", "tone_elegant"],
              ["luxury", "tone_luxury"],
            ] as const
          ).map(([v, key]) => (
            <label
              key={v}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <input
                type="radio"
                name="tone"
                value={v}
                checked={tone === v}
                onChange={() => setTone(v)}
              />
              {t(key)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-[var(--foreground)]">{t("suffixes")}</legend>
        <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{t("suffixesHint")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SUFFIX_OPTIONS.map((s) => (
            <label
              key={s}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2 font-mono text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <input
                type="checkbox"
                checked={suffixes.includes(s)}
                onChange={() => toggleSuffix(s)}
              />
              {s}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-[var(--foreground)]">{t("budget")}</legend>
        <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{t("budgetHint")}</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {budgetTiers.map((tier) => (
            <label
              key={tier}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand/5"
            >
              <input
                type="radio"
                name="maxBudget"
                value={tier}
                checked={maxFirstYearBudgetAmount === tier}
                onChange={() => setMaxFirstYearBudgetAmount(tier)}
              />
              {wizardBudgetTierLabel(budgetCurrency, tier, t)}
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="submit"
        data-testid="wizard-continue"
        className="w-full cursor-pointer rounded-xl bg-gradient-to-r from-brand to-brand-dark py-3 text-sm font-semibold text-white shadow-md shadow-brand/20 transition hover:opacity-95"
      >
        {t("continue")}
      </button>
    </form>
  );
}
