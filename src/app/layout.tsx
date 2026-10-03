import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insta Archive",
  description: "A personal, searchable archive of saved Instagram posts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/">Insta Archive</Link>
        </header>
        {children}
      </body>
    </html>
  );
}
