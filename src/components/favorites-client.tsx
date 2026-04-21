"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { RegistrarButtonRow } from "@/components/registrar-button-row";
import { UiTooltip } from "@/components/ui-tooltip";
import {
  exportFavoritesText,
  listFavorites,
  removeFavorite,
} from "@/lib/storage/favorites";
import { FAVORITES_CHANGED_EVENT } from "@/lib/storage/keys";
import type { FavoriteRecord } from "@/types/domain";

export function FavoritesClient() {
  const t = useTranslations("Favorites");
  const [rows, setRows] = useState<FavoriteRecord[]>([]);

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

  const download = () => {
    const blob = new Blob([exportFavoritesText()], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nameforme-favorites.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        <button
          type="button"
          onClick={download}
          disabled={rows.length === 0}
          className="rounded-xl border border-black/[0.08] bg-white px-4 py-2 text-sm font-semibold text-brand shadow-sm disabled:opacity-40"
        >
          {t("export")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((f) => (
            <li
              key={f.id}
              className="rounded-xl border border-black/[0.06] bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-semibold text-foreground">{f.domain}</p>
                  <p className="text-sm text-muted">
                    {f.score}/100 · {f.price} {f.currency} ·{" "}
                    {new Date(f.savedAt).toLocaleString()}
                  </p>
                </div>
                <UiTooltip label={t("remove")}>
                  <button
                    type="button"
                    onClick={() => {
                      removeFavorite(f.id);
                      refresh();
                    }}
                    className="shrink-0 rounded-lg border border-black/[0.08] bg-white p-1.5 text-muted hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    aria-label={t("remove")}
                  >
                    <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                  </button>
                </UiTooltip>
              </div>
              <div className="mt-3">
                <RegistrarButtonRow
                  domain={f.domain}
                  preferredRegistrar={f.registrar ?? "namecheap"}
                  presentation="text"
                  size="md"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
