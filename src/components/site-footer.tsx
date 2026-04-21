import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function SiteFooter() {
  const t = await getTranslations("Nav");

  return (
    <footer className="shrink-0 border-t border-[var(--border)] bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/about"
            className="transition-colors hover:text-[var(--foreground)]"
          >
            {t("about")}
          </Link>
          <Link
            href="/privacy"
            className="transition-colors hover:text-[var(--foreground)]"
          >
            {t("privacy")}
          </Link>
        </div>
        <p className="text-sm text-muted/70">
          © {new Date().getFullYear()} NameForMe
        </p>
      </div>
    </footer>
  );
}
