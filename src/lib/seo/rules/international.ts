import { reachImpact } from "@/lib/seo/impact";
import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { internationalCopy } from "./copy";
import { finishRule, makeDraft, type RankedDraft } from "./helpers";
import type { SeoRule } from "./types";

// SO13 uluslararası: Search Console ülke kodu (alfa-3, küçük harf) ana dile
// eşlenir. Ülke ≥ 500 gösterim aldıysa ve dili sitenin dillerinde
// (proje dili ∪ ana sayfa lang ∪ hreflang ∪ taranan sayfa lang) yoksa
// yerelleştirme önerilir. Sitenin hiçbir dili bilinmiyorsa kural susar.
// Çok dilli ülkelerde (İsviçre, Belçika…) en yaygın dil alınır.

export const SO13_MIN_IMPRESSIONS = 500;
export const SO13_MAX = 5;

// [alfa-3, ISO 639-1, İngilizce ülke adı]
const COUNTRIES: readonly (readonly [string, string, string])[] = [
  ["usa", "en", "the United States"],
  ["gbr", "en", "the United Kingdom"],
  ["can", "en", "Canada"],
  ["aus", "en", "Australia"],
  ["nzl", "en", "New Zealand"],
  ["irl", "en", "Ireland"],
  ["ind", "en", "India"],
  ["zaf", "en", "South Africa"],
  ["nga", "en", "Nigeria"],
  ["phl", "en", "the Philippines"],
  ["sgp", "en", "Singapore"],
  ["tur", "tr", "Turkey"],
  ["cyp", "el", "Cyprus"],
  ["aze", "az", "Azerbaijan"],
  ["mkd", "mk", "North Macedonia"],
  ["alb", "sq", "Albania"],
  ["xkx", "sq", "Kosovo"],
  ["srb", "sr", "Serbia"],
  ["bih", "bs", "Bosnia and Herzegovina"],
  ["hrv", "hr", "Croatia"],
  ["svn", "sl", "Slovenia"],
  ["mne", "sr", "Montenegro"],
  ["bgr", "bg", "Bulgaria"],
  ["grc", "el", "Greece"],
  ["rou", "ro", "Romania"],
  ["mda", "ro", "Moldova"],
  ["hun", "hu", "Hungary"],
  ["deu", "de", "Germany"],
  ["aut", "de", "Austria"],
  ["che", "de", "Switzerland"],
  ["fra", "fr", "France"],
  ["bel", "nl", "Belgium"],
  ["lux", "fr", "Luxembourg"],
  ["nld", "nl", "the Netherlands"],
  ["esp", "es", "Spain"],
  ["mex", "es", "Mexico"],
  ["arg", "es", "Argentina"],
  ["col", "es", "Colombia"],
  ["chl", "es", "Chile"],
  ["per", "es", "Peru"],
  ["prt", "pt", "Portugal"],
  ["bra", "pt", "Brazil"],
  ["ita", "it", "Italy"],
  ["pol", "pl", "Poland"],
  ["cze", "cs", "Czechia"],
  ["svk", "sk", "Slovakia"],
  ["swe", "sv", "Sweden"],
  ["nor", "no", "Norway"],
  ["dnk", "da", "Denmark"],
  ["fin", "fi", "Finland"],
  ["est", "et", "Estonia"],
  ["lva", "lv", "Latvia"],
  ["ltu", "lt", "Lithuania"],
  ["ukr", "uk", "Ukraine"],
  ["rus", "ru", "Russia"],
  ["blr", "ru", "Belarus"],
  ["kaz", "kk", "Kazakhstan"],
  ["geo", "ka", "Georgia"],
  ["isr", "he", "Israel"],
  ["sau", "ar", "Saudi Arabia"],
  ["are", "ar", "the United Arab Emirates"],
  ["egy", "ar", "Egypt"],
  ["irn", "fa", "Iran"],
  ["pak", "ur", "Pakistan"],
  ["jpn", "ja", "Japan"],
  ["kor", "ko", "South Korea"],
  ["chn", "zh", "China"],
  ["twn", "zh", "Taiwan"],
  ["vnm", "vi", "Vietnam"],
  ["tha", "th", "Thailand"],
  ["idn", "id", "Indonesia"],
];

export const COUNTRY_LANGUAGE: Readonly<Record<string, string>> =
  Object.fromEntries(COUNTRIES.map(([code, lang]) => [code, lang]));

const COUNTRY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  COUNTRIES.map(([code, , name]) => [code, name]),
);

const LANGUAGE_NAME: Readonly<Record<string, string>> = {
  en: "English",
  tr: "Turkish",
  el: "Greek",
  az: "Azerbaijani",
  mk: "Macedonian",
  sq: "Albanian",
  sr: "Serbian",
  bs: "Bosnian",
  hr: "Croatian",
  sl: "Slovenian",
  bg: "Bulgarian",
  ro: "Romanian",
  hu: "Hungarian",
  de: "German",
  fr: "French",
  nl: "Dutch",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  pl: "Polish",
  cs: "Czech",
  sk: "Slovak",
  sv: "Swedish",
  no: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  et: "Estonian",
  lv: "Latvian",
  lt: "Lithuanian",
  uk: "Ukrainian",
  ru: "Russian",
  kk: "Kazakh",
  ka: "Georgian",
  he: "Hebrew",
  ar: "Arabic",
  fa: "Persian",
  ur: "Urdu",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
};

// "en-US" → "en"; Norveççe nb/nn → no; x-default ve geçersizler düşer.
export function primaryLanguage(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const primary = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  return primary === "nb" || primary === "nn" ? "no" : primary;
}

export function siteLanguages(snapshot: RuleSnapshot): Set<string> {
  const langs = new Set<string>();
  const add = (code: string | null | undefined) => {
    const lang = primaryLanguage(code);
    if (lang) langs.add(lang);
  };
  add(snapshot.projectLanguage);
  for (const facts of snapshot.crawl?.pages ?? []) {
    add(facts.lang);
    for (const code of facts.hreflang) add(code);
  }
  return langs;
}

export const SO13: SeoRule = {
  key: "SO13_INTERNATIONAL",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const langs = siteLanguages(snapshot);
    const items: RankedDraft[] = [];
    if (langs.size === 0) return finishRule(items, SO13_MAX);
    for (const row of snapshot.countries) {
      if (row.impressions < SO13_MIN_IMPRESSIONS) continue;
      const code = row.country.trim().toLowerCase();
      const lang = COUNTRY_LANGUAGE[code];
      if (!lang || langs.has(lang)) continue;
      const metrics = {
        impressions: Math.round(row.impressions),
        clicks: Math.round(row.clicks),
      };
      items.push({
        rank: row.impressions,
        draft: makeDraft(snapshot, {
          ruleKey: "SO13_INTERNATIONAL",
          kind: "OPPORTUNITY",
          subject: `country:${code}`,
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: "L",
          actionKind: "LOCALIZE",
          impact: reachImpact(row.impressions),
          ...internationalCopy({
            country: COUNTRY_NAME[code] ?? code.toUpperCase(),
            language: LANGUAGE_NAME[lang] ?? lang,
            impressions: metrics.impressions,
          }),
          evidence: { window: snapshot.current, metrics, country: code },
          signalWorthy: true,
        }),
      });
    }
    return finishRule(items, SO13_MAX);
  },
};
