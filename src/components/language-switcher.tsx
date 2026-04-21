"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const isZh = locale === "zh";

  function toggle() {
    router.replace(pathname, { locale: isZh ? "en" : "zh" });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="group relative flex h-8 w-[72px] cursor-pointer items-center rounded-full border border-[var(--border)] bg-surface-hover p-0.5 transition-colors hover:border-[var(--border-hover)]"
      aria-label={isZh ? "Switch to English" : "切换到中文"}
    >
      <span
        className={`absolute top-0.5 h-7 w-[34px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          isZh ? "translate-x-0" : "translate-x-[34px]"
        }`}
      />
      <span
        className={`relative z-10 flex h-7 w-[34px] items-center justify-center text-sm font-semibold transition-colors ${
          isZh ? "text-foreground" : "text-muted"
        }`}
      >
        中
      </span>
      <span
        className={`relative z-10 flex h-7 w-[34px] items-center justify-center text-sm font-semibold transition-colors ${
          !isZh ? "text-foreground" : "text-muted"
        }`}
      >
        EN
      </span>
    </button>
  );
}
