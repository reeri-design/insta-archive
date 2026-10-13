import type { Metadata } from "next";
import { Instrument_Sans, Playfair_Display } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { SiteNav } from "./site-nav.tsx";

/*
 * The archive's two typefaces (docs/design-direction.md §14), self-hosted by next/font at build time.
 *  - Instrument Sans: the interface — navigation, search, metadata, controls. Calm and very legible
 *    at the small sizes dense views need, with a few hand-drawn details that keep it from feeling corporate.
 *  - Playfair Display: the editorial voice — captions, titles, notes, empty states. A
 *    high-contrast serif with a warm, slightly literary character.
 * They are exposed as CSS variables and used only through the type tokens in globals.css.
 */
const sans = Instrument_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-instrument-sans", display: "swap" });
const serif = Playfair_Display({ subsets: ["latin", "latin-ext"], style: ["normal", "italic"], variable: "--font-playfair-display", display: "swap" });

export const metadata: Metadata = {
  title: "Insta Archive",
  description: "A personal, searchable archive of saved Instagram posts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        {/* In the layout, so the nav stays in place while the page beneath it changes. */}
        <Suspense>
          <SiteNav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
