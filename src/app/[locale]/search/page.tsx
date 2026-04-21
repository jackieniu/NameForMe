import { setRequestLocale } from "next-intl/server";
import { SearchExperience } from "@/components/search-experience";
import { parseHomeScenarioParam } from "@/lib/home-scenario";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; scenario?: string; sessionId?: string }>;
};

export default async function SearchPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { q, scenario, sessionId } = await searchParams;
  const scenarioKey = parseHomeScenarioParam(scenario);

  return (
    <SearchExperience
      initialQuery={q ?? ""}
      initialScenarioKey={scenarioKey}
      initialSessionId={sessionId?.trim() || undefined}
      locale={locale}
    />
  );
}
