import type { SearchSessionRecord } from "@/types/domain";
import { SEARCH_SESSIONS_CHANGED_EVENT, SEARCH_SESSIONS_KEY } from "@/lib/storage/keys";

const MAX_SESSIONS = 25;

function readRaw(): SearchSessionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SEARCH_SESSIONS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? (data as SearchSessionRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(items: SearchSessionRecord[]) {
  try {
    window.localStorage.setItem(SEARCH_SESSIONS_KEY, JSON.stringify(items));
    window.dispatchEvent(new Event(SEARCH_SESSIONS_CHANGED_EVENT));
  } catch {
    /* ignore quota etc. */
  }
}

export function listSearchSessions(): SearchSessionRecord[] {
  return readRaw().sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function getSearchSession(id: string): SearchSessionRecord | undefined {
  if (!id.trim()) return undefined;
  return readRaw().find((s) => s.id === id);
}

export function upsertSearchSession(
  patch: Omit<SearchSessionRecord, "createdAt" | "updatedAt"> &
    Partial<Pick<SearchSessionRecord, "createdAt">>,
): void {
  const prev = readRaw();
  const idx = prev.findIndex((s) => s.id === patch.id);
  const now = new Date().toISOString();
  const row: SearchSessionRecord = {
    id: patch.id,
    title: patch.title,
    requirements: patch.requirements,
    messages: patch.messages,
    domains: patch.domains,
    strategyQueue: patch.strategyQueue,
    executedStrategyKeys: patch.executedStrategyKeys,
    historyDomains: patch.historyDomains,
    createdAt: idx >= 0 ? prev[idx].createdAt : (patch.createdAt ?? now),
    updatedAt: now,
  };
  const next =
    idx >= 0
      ? prev.map((s, i) => (i === idx ? row : s))
      : [row, ...prev.filter((s) => s.id !== row.id)].slice(0, MAX_SESSIONS);
  writeRaw(next);
}

export function deleteSearchSession(id: string): void {
  const next = readRaw().filter((s) => s.id !== id);
  writeRaw(next);
}

export function clearSearchSessions(): void {
  writeRaw([]);
}

export function sessionTitleFromRequirements(description: string): string {
  const t = description.trim();
  if (!t) return "—";
  return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}
