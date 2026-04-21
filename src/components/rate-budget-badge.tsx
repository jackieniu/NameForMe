"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateBrowserClientId } from "@/lib/browser-client-id";

type RateStatusPayload = {
  remaining: number;
  blocked: boolean;
  ipHourLeft: number;
  ipDayLeft: number;
  siteHourLeft: number;
};

/**
 * 当前会话剩余额度徽章：显示 min(IP 小时, IP 全天, 全站小时[, FP]) 余量。
 * 挂 `window` 级事件 `nfm:rate-refresh`，业务请求完成后可 dispatch 立即刷新。
 */
export function RateBudgetBadge() {
  const t = useTranslations("Search");
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
        ipHour: status.ipHourLeft,
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
