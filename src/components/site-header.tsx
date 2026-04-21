import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SavedDomainsNav } from "@/components/saved-domains-nav";

export async function SiteHeader() {
  const t = await getTranslations("Nav");
  const brand = await getTranslations("Common");

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--border)] bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-brand transition-colors hover:text-brand-dark"
          aria-label={brand("brand")}
        >
          <Image
            src="/logo.png"
            alt=""
            width={120}
            height={32}
            className="h-8 w-auto max-h-8 max-w-[min(160px,42vw)] shrink-0 object-contain object-left"
            style={{ width: "auto" }}
            aria-hidden
            priority
          />
          <span className="leading-none">{brand("brand")}</span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-3">
          <SavedDomainsNav />
          <Link
            href="/history"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:px-3"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 5v3l2 1.5" />
            </svg>
            {t("history")}
          </Link>
          <LanguageSwitcher />
        </nav>
      </div>
    </header>
  );
}
