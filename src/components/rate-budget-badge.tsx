"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateBrowserClientId } from "@/lib/browser-client-id";

type RateStatusPayload = {
  remaining: number;
  blocked: boolean;
  ipDayLeft: number;
  siteHourLeft: number;
};

function useRateStatus() {
  const [status, setStatus] = useState<RateStatusPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const fpRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fpRef.current = getOrCreateBrowserClientId();
  }, []);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/rate-status", {
        cache: "no-store",
        signal: ctrl.signal,
        headers: fpRef.current ? { "X-NFM-Fingerprint": fpRef.current } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as RateStatusPayload;
      setStatus(json);
      setFailed(false);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onRefresh = () => void refresh();
    window.addEventListener("nfm:rate-refresh", onRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("nfm:rate-refresh", onRefresh);
      abortRef.current?.abort();
    };
  }, [refresh]);

  return { status, failed };
}

/**
 * 当前会话剩余额度徽章：显示 min(IP 全天, 全站小时) 余量。
 * 挂 `window` 级事件 `nfm:rate-refresh`，业务请求完成后可 dispatch 立即刷新。
 */
export function RateBudgetBadge() {
  const t = useTranslations("Search");
  const { status, failed } = useRateStatus();

  if (failed && !status) return null;

  const remaining = status?.remaining ?? null;
  const blocked = status?.blocked ?? false;

  const tone = blocked || remaining === 0
    ? "border-red-200 bg-red-50 text-red-700"
    : (remaining ?? 999) <= 5
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-black/[0.06] bg-surface-hover text-muted";

  const label = blocked
    ? t("rateBlocked")
    : remaining == null
      ? t("rateLoading")
      : t("rateRemaining", { n: remaining });

  const title = status
    ? t("rateDetail", {
        ipDay: status.ipDayLeft,
        siteHour: status.siteHourLeft,
      })
    : "";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${tone}`}
      title={title}
      aria-live="polite"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

/** 业务请求完成后调用以立即刷新。 */
export function notifyRateRefresh() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("nfm:rate-refresh"));
}

/**
 * 当配额耗尽时，在对话框上方显示友好提示横幅。
 * remaining === 0 时根据具体原因显示不同文案。
 */
export function RateLimitBanner() {
  const t = useTranslations("Search");
  const { status } = useRateStatus();

  if (!status || status.remaining > 0) return null;

  let message: string;
  if (status.blocked) {
    message = t("rateBannerBlocked");
  } else if (status.siteHourLeft === 0) {
    message = t("rateBannerSiteHour");
  } else {
    message = t("rateBannerIpDay");
  }

  return (
    <div className="mb-3 shrink-0 flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
      <svg
        className="h-4 w-4 shrink-0 text-amber-500"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      <span>{message}</span>
    </div>
  );
}
