export type HomeScenarioValue = "startup" | "ecommerce" | "blog" | "app" | "other";

const ALL: readonly HomeScenarioValue[] = [
  "startup",
  "ecommerce",
  "blog",
  "app",
  "other",
];

export type HomeScenarioReadonlyKey = Exclude<HomeScenarioValue, "other">;

export function parseHomeScenarioParam(raw: string | undefined): HomeScenarioValue | undefined {
  if (!raw?.trim()) return undefined;
  const k = raw.trim().toLowerCase();
  return (ALL as readonly string[]).includes(k) ? (k as HomeScenarioValue) : undefined;
}

export function isReadonlyProductScenario(
  v: HomeScenarioValue | undefined,
): v is HomeScenarioReadonlyKey {
  return v !== undefined && v !== "other";
}
