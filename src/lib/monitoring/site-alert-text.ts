import { appUrl } from "@/lib/app-url";
import {
  SEARCH_TELEGRAM_FALLBACK,
  seoTelegramPhrase,
} from "@/lib/seo/health/alert-kinds";

import { siteAlertHref, type SiteAlertSource } from "./site-alert-href";

export type { SiteAlertSource } from "./site-alert-href";

// Site uyarılarının Telegram metni (yalnız sunucu: appUrl ortamı okur).
// Yalnız projenin kendi sohbetine gider (notifyProjectTelegram); düz metindir
// (telegramSendMessage parse_mode göndermez), bu yüzden HTML kaçışı yok.
// Google verisinden sayı, yol, sorgu ya da kampanya adı asla taşımaz: sabit
// bir ifade + proje adı + uygulama bağlantısı.

const PROJECT_NAME_MAX = 80;

const GA_PHRASES: Readonly<Record<string, string>> = {
  GA_MH1: "Google Analytics stopped receiving data",
  GA_MH1_RT: "Google Analytics shows no visitors right now",
  GA_MH6: "key events stopped arriving in Google Analytics",
  GA_MH12: "personal data may be in page addresses sent to Google Analytics",
  GA_MH24: "the Google Analytics connection needs attention",
};
const GA_FALLBACK = "Google Analytics tracking needs your attention";

function projectLabel(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return "your project";
  return clean.length > PROJECT_NAME_MAX
    ? clean.slice(0, PROJECT_NAME_MAX).trimEnd()
    : clean;
}

export function siteAlertTelegramText(input: {
  source: SiteAlertSource;
  kind: string;
  projectName: string;
  projectId: string;
  websitePage: boolean;
}): string {
  const name = projectLabel(input.projectName);
  const link = appUrl(
    siteAlertHref({
      source: input.source,
      projectId: input.projectId,
      websitePage: input.websitePage,
    }),
  ).toString();
  if (input.source === "GA4") {
    const phrase = GA_PHRASES[input.kind] ?? GA_FALLBACK;
    return `Website tracking alert for ${name}: ${phrase}. Open Agentelse: ${link}`;
  }
  // SEO (kendi taramamız, robots, CrUX): türe göre sabit ifade. GSC
  // (Search Console verisinden türeyen) uyarılar bulgu ifadesi taşımaz,
  // yalnız genel ifade (SC-F3 uzlaşması).
  const phrase =
    input.source === "SEO"
      ? seoTelegramPhrase(input.kind)
      : SEARCH_TELEGRAM_FALLBACK;
  return `Search alert for ${name}: ${phrase}. Open Agentelse: ${link}`;
}
