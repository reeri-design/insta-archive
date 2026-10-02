import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Insta Archive",
  description: "A personal, searchable archive of saved Instagram posts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
