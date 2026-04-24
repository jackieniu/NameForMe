/**
 * リクエストスコープの fetch 予算トラッカー
 *
 * AsyncLocalStorage でリクエストごとに独立したカウンターを管理し、
 * globalThis.fetch を一度だけラップして全 HTTP 呼び出し（CF Registrar・
 * Aliyun・LLM API など）を自動計上する。
 *
 * - D1 / KV はバインディング経由のため globalThis.fetch を経由しない。
 *   これら ~3 回の呼び出しは軽量なため budget 外でも問題ない。
 * - 複数リクエストが同一 isolate で並行実行されても、AsyncLocalStorage が
 *   コンテキストを分離するため互いのカウントには影響しない。
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface FetchBudgetState {
  /** 現在の fetch 呼び出し回数 */
  count: number;
  /**
   * ソフトリミット：hasRoom() が false を返す閾値。
   * 新しいドメインチェックを停止する。
   */
  readonly softLimit: number;
  /**
   * ハードリミット：この回数を超えた fetch は例外をスローする。
   * Workers の 1000 上限手前でクラッシュを防ぐ。
   */
  readonly hardLimit: number;
}

const _storage = new AsyncLocalStorage<FetchBudgetState>();
let _hooked = false;

function installHook(): void {
  if (_hooked) return;
  _hooked = true;

  const original = globalThis.fetch;

  // ラップした fetch を globalThis に代入。モジュールロード時に一度だけ実行。
  globalThis.fetch = function fetchWithBudget(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): ReturnType<typeof fetch> {
    const budget = _storage.getStore();
    if (budget) {
      budget.count++;

      // 100 刻みか、ソフトリミット超過時にログ出力
      if (budget.count % 100 === 0 || budget.count > budget.softLimit) {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        console.log(
          `[fetch-budget] #${budget.count}/${budget.hardLimit} (soft=${budget.softLimit}):`,
          url?.slice(0, 100),
        );
      }

      // ハードリミット超過 → 例外スロー
      if (budget.count > budget.hardLimit) {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        console.error(
          `[fetch-budget] HARD LIMIT exceeded: #${budget.count}/${budget.hardLimit}:`,
          url?.slice(0, 100),
        );
        throw new Error(
          `Subrequest budget exhausted (${budget.count}/${budget.hardLimit}): ${url?.slice(0, 80)}`,
        );
      }
    }

    return original.call(this, input, init);
  };
}

/**
 * 独立した fetch 予算コンテキストで fn を実行する。
 *
 * 大規模なドメイン検出フローで `fetch` 呼び出し数を上から抑える想定（ホストの接続/サブリクエスト制限向け）。
 *
 * @param fn         実行する非同期処理
 * @param hardLimit  fetch 呼び出しの上限
 * @param softLimit  これを超えたら新しいドメイン検出を打ち切る閾値
 */
export function runWithFetchBudget<T>(
  fn: () => Promise<T>,
  hardLimit = 9500,
  softLimit = 8000,
): Promise<T> {
  installHook();
  return _storage.run({ count: 0, hardLimit, softLimit }, fn);
}

/** 現在コンテキストで残り何回 fetch を発行できるか（ソフトリミット基準） */
export function fetchBudgetRemaining(): number {
  const s = _storage.getStore();
  if (!s) return 9999;
  return Math.max(0, s.softLimit - s.count);
}

/** n 回の fetch を発行する余裕があるか（ソフトリミット基準） */
export function fetchBudgetHasRoom(n = 1): boolean {
  const s = _storage.getStore();
  if (!s) return true;
  return s.count + n <= s.softLimit;
}

/** 現在の fetch 呼び出し回数 */
export function fetchBudgetSpent(): number {
  return _storage.getStore()?.count ?? 0;
}
