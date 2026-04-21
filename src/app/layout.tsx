import type { ReactNode } from "react";

/** Root passes through; `<html>` lives in `[locale]/layout.tsx` for correct `lang`. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
