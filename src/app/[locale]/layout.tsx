import type { Metadata } from "next";
import { createElement } from "react";
import { Inter } from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import "../globals.css";
import { routing } from "@/i18n/routing";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getMetadataBase } from "@/lib/site-url";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const metadataBase = await getMetadataBase();
  return {
    title: t("title"),
    description: t("description"),
    icons: {
      icon: [{ url: "/favicon.ico", sizes: "any" }],
      shortcut: "/favicon.ico",
    },
    metadataBase,
    alternates: {
      canonical: `/${locale}`,
      languages: {
        en: "/en",
        zh: "/zh",
      },
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {createElement("meta", {
          name: "impact-site-verification",
          value: "3e97dc77-1eb1-46a9-b336-4aca310f6830",
        } as React.MetaHTMLAttributes<HTMLMetaElement> & { value: string })}
      </head>
      <body
        className={`${inter.variable} min-h-dvh bg-background font-sans text-foreground antialiased`}
        style={{
          fontFamily:
            'var(--font-inter), "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
        }}
      >
        <NextIntlClientProvider messages={messages}>
          <div className="site-shell flex min-h-0 min-h-dvh w-full max-w-full flex-col">
            <SiteHeader />
            <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pt-0">
              {children}
            </main>
            <SiteFooter />
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
