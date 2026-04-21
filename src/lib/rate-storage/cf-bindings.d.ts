/** 最小可用的 KV / D1 类型（避免引入 @cloudflare/workers-types 依赖）。 */

export interface KVNamespace {
  get(key: string, options?: { type?: "text" | "json" }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: unknown;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

export interface CloudflareBindings {
  BLOCKLIST: KVNamespace;
  DB: D1Database;
}
