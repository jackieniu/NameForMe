import { headers } from "next/headers";

/**
 * 用于 metadata、JSON-LD 等绝对地址。
 * 开发环境始终跟随当前请求的 Host（避免用固定 localhost 时，用 127.0.0.1 访问却去请求 localhost 导致 404）。
 */
export async function getRequestSiteUrl(): Promise<string> {
  if (process.env.NODE_ENV === "development") {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? "http";
    const cleanHost = host.split(",")[0]?.trim() ?? "localhost:3000";
    return `${proto}://${cleanHost}`;
  }
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://nameforme.com"
  );
}

export async function getMetadataBase(): Promise<URL> {
  return new URL(`${await getRequestSiteUrl()}/`);
}
