import { setRequestLocale } from "next-intl/server";
import { FavoritesClient } from "@/components/favorites-client";

type Props = { params: Promise<{ locale: string }> };

export default async function FavoritesPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <FavoritesClient />
    </div>
  );
}
