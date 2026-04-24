import { NextResponse } from "next/server";

/** 健康检查与外部探针：无外部依赖、不调用 LLM / Redis。 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ok: true, t: new Date().toISOString() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
