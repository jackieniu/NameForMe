import type { FavoriteRecord, RegistrarId } from "@/types/domain";
import { FAVORITES_CHANGED_EVENT, FAVORITES_KEY } from "@/lib/storage/keys";

function notifyFavoritesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT));
}

function readRaw(): FavoriteRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? (data as FavoriteRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(items: FavoriteRecord[]) {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(items));
    notifyFavoritesChanged();
  } catch {
    /* ignore quota */
  }
}

export function listFavorites(): FavoriteRecord[] {
  return readRaw().sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );
}

export function addFavorite(rec: {
  domain: string;
  score: number;
  price: number;
  currency: string;
  affiliateUrl?: string;
  registrar?: RegistrarId;
}) {
  const items = readRaw();
  if (items.some((x) => x.domain.toLowerCase() === rec.domain.toLowerCase())) return;
  const row: FavoriteRecord = {
    ...rec,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
  };
  writeRaw([row, ...items]);
}

export function isFavoriteDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return readRaw().some((x) => x.domain.toLowerCase() === d);
}

export function removeFavorite(id: string) {
  writeRaw(readRaw().filter((x) => x.id !== id));
}

export function exportFavoritesText(): string {
  return listFavorites()
    .map((f) => `${f.domain}\tscore:${f.score}\t${f.price} ${f.currency}`)
    .join("\n");
}
