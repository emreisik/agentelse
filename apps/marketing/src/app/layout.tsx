import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

// OpenAI Sans is proprietary and distributed through OpenAI's gated brand
// portal. Inter is the metric-compatible, self-hosted fallback until licensed
// OpenAI Sans files are supplied; CSS still keeps the real family first.
const openAiSansFallback = Inter({
  variable: "--font-openai-sans-fallback",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "Agentelse — Your Autonomous Growth Department",
    template: "%s — Agentelse",
  },
  description:
    "Agentelse researches your market, discovers opportunities, coordinates specialized AI teams and turns strategy into execution — continuously.",
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
      className={`${openAiSansFallback.variable} h-full antialiased notranslate`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <MarketingNav />
        <main className="flex-1">{children}</main>
        <MarketingFooter />
      </body>
    </html>
  );
}
