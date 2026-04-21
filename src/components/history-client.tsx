"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import {
  clearSearchSessions,
  deleteSearchSession,
  listSearchSessions,
} from "@/lib/storage/search-sessions";
import { SEARCH_SESSIONS_CHANGED_EVENT } from "@/lib/storage/keys";
import type { SearchSessionRecord } from "@/types/domain";

export function HistoryClient() {
  const t = useTranslations("History");
  const router = useRouter();
  const [rows, setRows] = useState<SearchSessionRecord[]>([]);

  const refresh = useCallback(() => {
    setRows(listSearchSessions());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const bump = () => refresh();
    window.addEventListener("storage", bump);
    window.addEventListener(SEARCH_SESSIONS_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener("storage", bump);
      window.removeEventListener(SEARCH_SESSIONS_CHANGED_EVENT, bump);
    };
  }, [refresh]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        <button
          type="button"
          onClick={() => {
            clearSearchSessions();
            refresh();
            router.push("/");
          }}
          disabled={rows.length === 0}
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-40"
        >
          {t("clear")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((h) => {
            return (
              <li
                key={h.id}
                className="flex flex-col gap-3 rounded-xl border border-black/[0.06] bg-white p-4 shadow-sm sm:flex-row sm:items-stretch sm:justify-between"
              >
                <Link
                  href={`/search?sessionId=${encodeURIComponent(h.id)}`}
                  className="min-w-0 flex-1 rounded-lg no-underline outline-none ring-brand/30 transition-colors hover:bg-muted/15 focus-visible:ring-2"
                >
                  <p className="text-sm text-muted">
                    {new Date(h.updatedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">{h.title}</p>
                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    {t("metaLine", {
                      domainCount: h.domains.length,
                      strategyRunCount: h.executedStrategyKeys.length,
                    })}
                  </p>
                  <p className="mt-2 text-sm font-medium text-brand">{t("resume")}</p>
                </Link>
                <div className="flex shrink-0 flex-row gap-2 sm:flex-col sm:justify-center">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      deleteSearchSession(h.id);
                      refresh();
                      if (listSearchSessions().length === 0) {
                        router.push("/");
                      }
                    }}
                    className="rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    {t("delete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
