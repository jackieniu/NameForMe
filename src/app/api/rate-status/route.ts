import { getClientIp, getRateStatus } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只读；不占用配额，不需要 Turnstile。 */
export async function GET(req: Request) {
  const ip = getClientIp(req);
  const status = await getRateStatus(ip);
  return Response.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
