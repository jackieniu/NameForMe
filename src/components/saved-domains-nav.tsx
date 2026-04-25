"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { RegistrarButtonRow } from "@/components/registrar-button-row";
import { UiTooltip } from "@/components/ui-tooltip";
import { FAVORITES_CHANGED_EVENT } from "@/lib/storage/keys";
import { listFavorites, removeFavorite } from "@/lib/storage/favorites";
import type { FavoriteRecord } from "@/types/domain";

export function SavedDomainsNav() {
  const tNav = useTranslations("Nav");
  const tFav = useTranslations("Favorites");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FavoriteRecord[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    setRows(listFavorites());
  }, []);

  useEffect(() => {
    refresh();
    const on = () => refresh();
    window.addEventListener("storage", on);
    window.addEventListener(FAVORITES_CHANGED_EVENT, on);
    return () => {
      window.removeEventListener("storage", on);
      window.removeEventListener(FAVORITES_CHANGED_EVENT, on);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = rows.length;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:px-2.5"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${tNav("savedDomains")} (${count})`}
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
          aria-hidden
          className="hidden md:block shrink-0"
        >
          <path d="M8 2.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 11.9l-3.52 1.85.67-3.93-2.85-2.78 3.94-.57L8 2.5z" />
        </svg>
        <span>{tNav("savedDomains")} ({count})</span>
      </button>

      {open ? (
        <div
          className="fixed left-4 right-4 top-[4.5rem] z-[60] rounded-xl border border-black/[0.08] bg-white py-2 shadow-lg sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[min(100vw-2rem,22rem)]"
          role="dialog"
          aria-label={tNav("savedDomains")}
        >
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">{tFav("empty")}</p>
          ) : (
            <ul className="max-h-[26rem] overflow-y-auto overscroll-contain px-2">
              {rows.map((f) => (
                <li
                  key={f.id}
                  className="flex min-w-0 items-center gap-1 border-b border-black/[0.06] py-2.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">
                    {f.domain}
                  </span>
                  <RegistrarButtonRow
                    domain={f.domain}
                    presentation="icon"
                    size="sm"
                    className="shrink-0"
                  />
                  <UiTooltip label={tFav("remove")}>
                    <button
                      type="button"
                      onClick={() => {
                        removeFavorite(f.id);
                        refresh();
                      }}
                      className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-red-50 hover:text-red-600"
                      aria-label={tFav("remove")}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    </button>
                  </UiTooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
