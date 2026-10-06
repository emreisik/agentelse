import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

import { SiteNav } from "@/components/site/nav";
import { SiteFooter } from "@/components/site/footer";
import { SITE_URL } from "@/lib/site";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Agentelse — Your AI social media team",
    template: "%s — Agentelse",
  },
  description:
    "Agentelse plans, designs and publishes your social media posts in your brand's style. You just approve.",
  openGraph: {
    type: "website",
    siteName: "Agentelse",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      translate="no"
      data-scroll-behavior="smooth"
      className={`${inter.variable} h-full antialiased notranslate`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <SiteNav />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
