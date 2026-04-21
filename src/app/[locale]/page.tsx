import { getTranslations, setRequestLocale } from "next-intl/server";
import { HomeLanding } from "@/components/home-landing";
import { getRequestSiteUrl } from "@/lib/site-url";

type Props = { params: Promise<{ locale: string }> };

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Home");
  const meta = await getTranslations("Metadata");
  const site = await getRequestSiteUrl();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "NameForMe",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: `${site}/${locale}`,
    description: meta("description"),
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  const keys = [
    "heroTag", "heroTitle", "heroSubtitle",
    "scenarioTitle", "scenarioSubtitle",
    "scenarioStartup", "scenarioStartupDesc",
    "scenarioEcommerce", "scenarioEcommerceDesc",
    "scenarioBlog", "scenarioBlogDesc",
    "scenarioApp", "scenarioAppDesc",
    "scenarioOther", "scenarioOtherDesc",
    "scenarioOrCustom", "scenarioCustomPlaceholder", "scenarioCustomButton",
    "statsTitle", "statsDomains", "statsAvailability", "statsTime", "statsTimeSuffix",
    "howTitle", "howSubtitle",
    "step1Title", "step1Body", "step2Title", "step2Body", "step3Title", "step3Body",
    "featuresTitle", "featuresSubtitle",
    "feature1Title", "feature1Body", "feature2Title", "feature2Body",
    "feature3Title", "feature3Body", "feature4Title", "feature4Body",
    "feature5Title", "feature5Body", "feature6Title", "feature6Body",
    "faqTitle",
    "faq1Q", "faq1A", "faq2Q", "faq2A", "faq3Q", "faq3A", "faq4Q", "faq4A",
    "ctaTitle", "ctaSubtitle", "ctaButton",
  ] as const;

  const translations: Record<string, string> = {};
  for (const key of keys) {
    translations[key] = t(key);
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomeLanding t={translations} />
    </>
  );
}
