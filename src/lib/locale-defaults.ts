import { normalizeDomain } from "@/lib/domain";
import {
  type CountryCode,
  type LanguageCode,
  isSupportedCountry,
  isSupportedLanguage,
} from "@/lib/locales";

// The one place that knows which market and content language a new project
// should start from. Pure and isomorphic: the server reads its inputs (the
// typed website, the workspace's latest project, the Accept-Language header),
// the browser only ever shows the answer with its provenance. Nothing here is a
// setting: the person's own tap always replaces it, and when there is no signal
// nothing is pre-selected at all.

export const LOCALE_SOURCES = ["tld", "previous", "browser"] as const;
export type LocaleSource = (typeof LOCALE_SOURCES)[number];

export function isLocaleSource(value: unknown): value is LocaleSource {
  return LOCALE_SOURCES.some((source) => source === value);
}

export type LocaleDefault = {
  country: CountryCode;
  language: LanguageCode;
  source: LocaleSource;
} | null;

// Typed as a full record so that adding a market to SUPPORTED_COUNTRIES without
// deciding its language does not compile. Countries whose language is not
// offered fall back to English; the screen shows the language with a Change
// control, so the fallback is visible and never silent.
const COUNTRY_LANGUAGE: Record<CountryCode, LanguageCode> = {
  TR: "tr",
  MK: "mk",
  AL: "sq",
  XK: "sq",
  RS: "sr",
  BG: "bg",
  GR: "el",
  RO: "en",
  BA: "sr",
  ME: "sr",
  HR: "en",
  DE: "de",
  AT: "de",
  CH: "de",
  NL: "nl",
  BE: "nl",
  FR: "fr",
  IT: "it",
  ES: "es",
  PT: "en",
  GB: "en",
  IE: "en",
  PL: "en",
  SE: "en",
  NO: "en",
  DK: "en",
  AE: "ar",
  SA: "ar",
  US: "en",
  CA: "en",
};

// Total over SUPPORTED_COUNTRIES; anything else reads as English.
export function languageForCountry(country: string): LanguageCode {
  return isSupportedCountry(country) ? COUNTRY_LANGUAGE[country] : "en";
}

// Country-code TLDs that say something about the customers. `.xk` (not an
// official code) and `.me` (sold as a generic domain) are deliberately absent,
// and so is every generic TLD. A Map, not an object, so a label such as
// "constructor" can never hit a prototype member.
const TLD_COUNTRY = new Map<string, CountryCode>([
  ["tr", "TR"],
  ["mk", "MK"],
  ["al", "AL"],
  ["rs", "RS"],
  ["bg", "BG"],
  ["gr", "GR"],
  ["ro", "RO"],
  ["ba", "BA"],
  ["hr", "HR"],
  ["de", "DE"],
  ["at", "AT"],
  ["ch", "CH"],
  ["nl", "NL"],
  ["be", "BE"],
  ["fr", "FR"],
  ["it", "IT"],
  ["es", "ES"],
  ["pt", "PT"],
  ["uk", "GB"],
  ["ie", "IE"],
  ["pl", "PL"],
  ["se", "SE"],
  ["no", "NO"],
  ["dk", "DK"],
  ["ae", "AE"],
  ["sa", "SA"],
  ["us", "US"],
  ["ca", "CA"],
]);

// The last label decides, so `shop.co.uk` and `shop.com.tr` both work.
export function countryForTld(domain: string): CountryCode | null {
  const host = normalizeDomain(domain).replace(/\.+$/, "");
  if (!host.includes(".")) return null;
  const label = host.slice(host.lastIndexOf(".") + 1);
  return TLD_COUNTRY.get(label) ?? null;
}

export type AcceptedLanguage = { language: string; country?: string };

// The header is attacker-controlled input: it is capped before it is split.
const MAX_HEADER_LENGTH = 512;
const MAX_ENTRIES = 16;
const LANGUAGE_TAG = /^([a-z]{2,3})((?:-[a-z0-9]{1,8})*)$/i;

// "tr-TR,tr;q=0.9,en-US;q=0.8" -> [{tr, TR}, {tr}, {en, US}], best first. A
// wildcard, a malformed entry and a q of 0 ("not acceptable") are dropped; the
// region is the two-letter subtag (`sr-Latn-RS` -> RS, `es-419` -> none).
export function parseAcceptLanguage(
  header: string | null | undefined,
): AcceptedLanguage[] {
  if (!header) return [];
  const entries: (AcceptedLanguage & { q: number; order: number })[] = [];
  header
    .slice(0, MAX_HEADER_LENGTH)
    .split(",")
    .slice(0, MAX_ENTRIES)
    .forEach((part, order) => {
      const [rawTag = "", ...params] = part.split(";");
      const match = LANGUAGE_TAG.exec(rawTag.trim());
      if (!match) return;
      let q = 1;
      for (const param of params) {
        const [key = "", value = ""] = param.split("=").map((s) => s.trim());
        if (key.toLowerCase() === "q") q = Number(value);
      }
      if (!Number.isFinite(q) || q <= 0 || q > 1) return;
      const country = (match[2] ?? "")
        .split("-")
        .find((subtag) => /^[a-z]{2}$/i.test(subtag))
        ?.toUpperCase();
      entries.push({
        language: (match[1] ?? "").toLowerCase(),
        ...(country ? { country } : {}),
        q,
        order,
      });
    });
  return entries
    .sort((a, b) => b.q - a.q || a.order - b.order)
    .map(({ language, country }) =>
      country ? { language, country } : { language },
    );
}

// A language alone names a market only where it is unambiguous: German could be
// DE, AT or CH, so it is not here.
const LANGUAGE_ONLY_COUNTRY = new Map<string, CountryCode>([
  ["tr", "TR"],
  ["es", "ES"],
  ["mk", "MK"],
  ["bg", "BG"],
  ["el", "GR"],
]);

function fromBrowser(header: string | null | undefined): LocaleDefault {
  for (const { language, country } of parseAcceptLanguage(header)) {
    if (country && isSupportedCountry(country)) {
      // en-US is the factory setting of most machines: it says nothing about
      // where this brand's customers are (and this base is Balkans/Turkey-heavy).
      if (language === "en" && country === "US") continue;
      return {
        country,
        language: languageForCountry(country),
        source: "browser",
      };
    }
    const only = LANGUAGE_ONLY_COUNTRY.get(language);
    if (only) {
      return {
        country: only,
        language: languageForCountry(only),
        source: "browser",
      };
    }
  }
  return null;
}

// The ladder, highest wins: (1) the country-code TLD of the typed website,
// because it is evidence about THIS brand; (2) the workspace's latest project;
// (3) the browser's language; (4) nothing, which keeps every chip unselected.
// The person's own tap sits above all of these and is not this function's job.
export function pickLocaleDefault(input: {
  domain?: string;
  previous?: { language: string; country: string } | null;
  acceptLanguage?: string | null;
}): LocaleDefault {
  const tld = input.domain ? countryForTld(input.domain) : null;
  if (tld) {
    return { country: tld, language: languageForCountry(tld), source: "tld" };
  }
  const previous = input.previous;
  if (
    previous &&
    isSupportedCountry(previous.country) &&
    isSupportedLanguage(previous.language)
  ) {
    return {
      country: previous.country,
      language: previous.language,
      source: "previous",
    };
  }
  return fromBrowser(input.acceptLanguage);
}
