import type { DomainRequirements } from "@/types/domain";

type WizardT = (key: string) => string;

function budgetSummary(req: DomainRequirements, tw: WizardT): string {
  if (req.maxFirstYearBudgetAmount === 0) return tw("budgetTier_unlimited");
  if (req.budgetCurrency === "USD") {
    const n = req.maxFirstYearBudgetAmount;
    if (n === 10) return tw("budgetTierUsd_10");
    if (n === 100) return tw("budgetTierUsd_100");
    if (n === 1000) return tw("budgetTierUsd_1000");
    if (n === 10000) return tw("budgetTierUsd_10000");
    return String(n);
  }
  const n = req.maxFirstYearBudgetAmount;
  if (n === 100) return tw("budgetTier_100");
  if (n === 1000) return tw("budgetTier_1000");
  if (n === 10000) return tw("budgetTier_10000");
  if (n === 100000) return tw("budgetTier_100000");
  return String(n);
}

/** 将问卷结果格式化为一条用户消息（用于对话区展示） */
export function formatQuestionnaireUserMessage(req: DomainRequirements, tw: WizardT): string {
  const market = tw(`market_${req.market}`);
  const tone = tw(`tone_${req.tone}`);
  const suffixes = req.suffixes.join(", ");
  const budget = budgetSummary(req, tw);
  const lines: string[] = [];
  if (req.homeScenarioLabel?.trim()) {
    lines.push(`${tw("productType")}: ${req.homeScenarioLabel.trim()}`);
  }
  lines.push(
    `${tw("description")}: ${req.description}`,
    `${tw("market")}: ${market}`,
    `${tw("tone")}: ${tone}`,
    `${tw("suffixes")}: ${suffixes}`,
    `${tw("budget")}: ${budget}`,
  );
  return lines.join("\n");
}
