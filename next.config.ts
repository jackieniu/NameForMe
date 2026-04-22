import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

initOpenNextCloudflareForDev();

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  /** `ai` 依赖 @opentelemetry/api；打入 vendor chunk 时偶发缺失文件导致 /search 500，外置为 Node 直引 */
  serverExternalPackages: ["@opentelemetry/api"],
};

export default withNextIntl(nextConfig);
