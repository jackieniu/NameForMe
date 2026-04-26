import type { ApiGateResult } from "@/lib/rate-limit";
import {
  getClientIp,
  isIpBlocked,
  noteTurnstileFailure,
  tryConsumeApiSlot,
} from "@/lib/rate-limit";
import {
  getMemoryOnlyStorage,
  getRateStorage,
  hasPersistedRateStorage,
} from "@/lib/rate-storage";
import { isTurnstileEnforced, verifyTurnstileToken } from "@/lib/turnstile";

export function jsonGateErrorResponse(g: Extract<ApiGateResult, { ok: false }>): Response {
  if (g.kind === "blocked") {
    return Response.json({ code: "IP_BLOCKED" }, { status: 403 });
  }
  if (g.kind === "site_degraded") {
    const ra = String(g.retryAfterSec ?? 3600);
    return Response.json(
      { code: "SITE_DEGRADED", retryAfterSec: g.retryAfterSec ?? 3600 },
      { status: 503, headers: { "Retry-After": ra } },
    );
  }
  const ra = g.retryAfterSec;
  return Response.json(
    { code: "RATE_LIMIT", kind: g.kind, retryAfterSec: ra },
    {
      status: 429,
      headers: ra ? { "Retry-After": String(ra) } : {},
    },
  );
}

/**
 * 面向计费 (LLM / 外部付费) 接口：Turnstile；**仅已配置 Upstash Redis 时**再走全局限流。
 * 通过返回 null；否则返回错误 Response。
 *
 * skipTurnstile: 跳过 Turnstile 校验（用于次要接口，保留限流）。
 * Turnstile token 是一次性的——同一 token 不能给两个接口共用，
 * 对仅需限流、不强制人机校验的辅助接口可传 `skipTurnstile: true`。
 */
export async function protectAfterJsonParsed(opts: {
  req: Request;
  turnstileToken: string | undefined;
  skipTurnstile?: boolean;
}): Promise<Response | null> {
  const storage = getRateStorage();
  const ip = getClientIp(opts.req);

  if (await isIpBlocked(ip, storage)) {
    return Response.json({ code: "IP_BLOCKED" }, { status: 403 });
  }

  if (!opts.skipTurnstile && isTurnstileEnforced()) {
    const ok = await verifyTurnstileToken(opts.turnstileToken, ip);
    if (!ok) {
      await noteTurnstileFailure(ip, storage);
      return Response.json({ code: "TURNSTILE_FAILED" }, { status: 403 });
    }
  }

  if (hasPersistedRateStorage()) {
    const gate = await tryConsumeApiSlot(ip, storage);
    if (!gate.ok) return jsonGateErrorResponse(gate);
  }
  return null;
}

/**
 * 面向非计费接口 (`/api/domains/check` 等)：内存黑名单；**无持久化存储时不占配额**。
 * 有绑定时仍只对 check 使用进程内计数（不写入远端存储），与历史行为一致。
 */
export async function protectRateOnly(req: Request): Promise<Response | null> {
  const storage = getMemoryOnlyStorage();
  const ip = getClientIp(req);
  if (await isIpBlocked(ip, storage)) {
    return Response.json({ code: "IP_BLOCKED" }, { status: 403 });
  }
  if (hasPersistedRateStorage()) {
    const gate = await tryConsumeApiSlot(ip, storage);
    if (!gate.ok) return jsonGateErrorResponse(gate);
  }
  return null;
}
