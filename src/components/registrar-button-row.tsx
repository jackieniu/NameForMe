"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { buildAffiliateUrl } from "@/lib/domains/affiliate";
import { UiTooltip } from "@/components/ui-tooltip";
import type { RegistrarId } from "@/types/domain";

type LinkLabelKey = "registerLinkAliyun" | "registerLinkGodaddy";
type OpenTooltipKey = "registerOpenAliyun" | "registerOpenGodaddy";

/**
 * 注册商入口：href、文案、tooltip、可选 SVG（顶栏收藏下拉用紧凑图标）。
 * 搜索页「可用域名」卡片使用 `presentation="text"`，仅文字 + 品牌色底。
 */
export const REGISTRAR_CONFIG: Record<
  RegistrarId,
  {
    href: (domain: string) => string;
    labelKey: LinkLabelKey;
    tooltipKey: OpenTooltipKey;
    iconSrc: string;
    className: string;
  }
> = {
  aliyun: {
    href: (d) => buildAffiliateUrl(d, "aliyun"),
    labelKey: "registerLinkAliyun",
    tooltipKey: "registerOpenAliyun",
    iconSrc: "/aliyun.svg",
    className:
      "bg-[#d95e00] text-white shadow-sm hover:bg-[#b84e00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d95e00]",
  },
  godaddy: {
    href: (d) => buildAffiliateUrl(d, "godaddy"),
    labelKey: "registerLinkGodaddy",
    tooltipKey: "registerOpenGodaddy",
    iconSrc: "/godaddy.svg",
    className:
      "bg-[#1BDBAD] text-white shadow-sm hover:bg-[#17c49b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1BDBAD]",
  },
};

export const REGISTRAR_ORDER: readonly RegistrarId[] = ["aliyun", "godaddy"];

/** TLD 列表：阿里云不出售，不显示阿里云注册按钮 */
const ALIYUN_UNSUPPORTED_TLDS = new Set([".io", ".ai", ".org", ".co", ".app", ".dev"]);

export function skipRegistrarButton(
  domain: string,
  registrar: RegistrarId,
): boolean {
  const d = domain.trim().toLowerCase();
  const tld = d.includes(".") ? d.slice(d.indexOf(".")) : "";
  if (registrar === "aliyun" && ALIYUN_UNSUPPORTED_TLDS.has(tld)) return true;
  return false;
}

export type RegistrarPresentation = "text" | "icon";

/** 单个注册商入口：`text` = 彩色文字按钮（搜索列表）；`icon` = 无底色图标链（顶栏收藏）。 */
export function RegistrarButton({
  domain,
  registrar,
  size = "md",
  presentation = "text",
  wrapperClassName,
}: {
  domain: string;
  registrar: RegistrarId;
  size?: "sm" | "md";
  presentation?: RegistrarPresentation;
  wrapperClassName?: string;
}) {
  const t = useTranslations("Search");
  const cfg = REGISTRAR_CONFIG[registrar];

  if (presentation === "icon") {
    const px = size === "sm" ? 16 : 18;
    return (
      <UiTooltip
        label={t(cfg.tooltipKey)}
        wrapperClassName={wrapperClassName ?? "shrink-0"}
      >
        <a
          href={cfg.href(domain)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t(cfg.tooltipKey)}
          className="inline-flex rounded-md p-1 text-muted transition-colors hover:bg-black/[0.06] hover:text-foreground"
        >
          <Image
            src={cfg.iconSrc}
            alt=""
            width={px}
            height={px}
            className="object-contain"
            unoptimized
            aria-hidden
          />
        </a>
      </UiTooltip>
    );
  }

  const padding =
    size === "sm"
      ? "min-h-8 px-1.5 py-1 text-[11px] sm:text-xs"
      : "min-h-10 px-1.5 py-2 text-xs sm:px-2 sm:text-sm";
  return (
    <UiTooltip
      label={t(cfg.tooltipKey)}
      wrapperClassName={wrapperClassName ?? "min-w-0 flex-1"}
    >
      <a
        href={cfg.href(domain)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t(cfg.tooltipKey)}
        className={`inline-flex w-full min-w-0 flex-1 items-center justify-center rounded-lg font-semibold leading-tight transition-colors ${padding} ${cfg.className}`}
      >
        <span className="line-clamp-2 text-center">{t(cfg.labelKey)}</span>
      </a>
    </UiTooltip>
  );
}

export function RegistrarButtonRow({
  domain,
  size = "md",
  presentation = "text",
  className,
}: {
  domain: string;
  size?: "sm" | "md";
  presentation?: RegistrarPresentation;
  className?: string;
}) {
  const visible = REGISTRAR_ORDER.filter((rid) => !skipRegistrarButton(domain, rid));
  const gap =
    presentation === "icon"
      ? "gap-0.5"
      : size === "sm"
        ? "gap-1"
        : "gap-1.5";
  return (
    <div className={`flex min-w-0 items-center ${gap} ${className ?? ""}`}>
      {visible.map((rid) => (
        <RegistrarButton
          key={rid}
          domain={domain}
          registrar={rid}
          size={size}
          presentation={presentation}
          wrapperClassName={
            presentation === "icon" ? "shrink-0" : undefined
          }
        />
      ))}
    </div>
  );
}
