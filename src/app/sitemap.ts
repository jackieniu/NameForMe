import type { MetadataRoute } from "next";
import { routing } from "@/i18n/routing";

const paths = ["", "/search", "/about", "/privacy", "/history"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const entries: MetadataRoute.Sitemap = [];
  for (const locale of routing.locales) {
    for (const path of paths) {
      entries.push({
        url: `${base}/${locale}${path}`,
        lastModified: new Date(),
      });
    }
  }
  return entries;
}
