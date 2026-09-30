import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { type LocaleSource, isLocaleSource } from "@/lib/locale-defaults";
import {
  type CountryCode,
  type LanguageCode,
  isSupportedCountry,
  isSupportedLanguage,
} from "@/lib/locales";

// What the create-project form may send. A Server Action is a public POST
// endpoint, so the screen's own checks are a convenience and this parser is the
// rule: every failure names the field it belongs to, so the client can print it
// next to the input instead of the form silently doing nothing.

export const NAME_MAX_LENGTH = 120;
export const DOMAIN_MAX_LENGTH = 253;
export const MAX_MARKETS = 30;

export type CreateProjectField =
  "name" | "domain" | "brandName" | "language" | "country";

export type CreateProjectInput = {
  name: string;
  // A bare domain ("shop.example.com"): no scheme, no www, no path.
  domain?: string;
  brandName?: string;
  language: LanguageCode;
  // The first market is the primary one (`country`); the rest are display-only.
  countries: CountryCode[];
  country: CountryCode;
  // Where the pre-selected market came from, only to measure how good the
  // defaults are. Anything that is not a known source is dropped.
  localeSource?: LocaleSource;
};

export type CreateProjectParse =
  | { ok: true; value: CreateProjectInput }
  | { ok: false; field?: CreateProjectField; message: string };

function textOf(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function fail(field: CreateProjectField, message: string): CreateProjectParse {
  return { ok: false, field, message };
}

export function parseCreateProjectForm(formData: FormData): CreateProjectParse {
  const name = textOf(formData, "name");
  if (!name) return fail("name", "Enter your brand name.");
  if (name.length > NAME_MAX_LENGTH) {
    return fail(
      "name",
      `Brand name is too long (${NAME_MAX_LENGTH} characters at most).`,
    );
  }

  const rawDomain = textOf(formData, "domain");
  let domain: string | undefined;
  if (rawDomain) {
    const normalized = normalizeDomain(rawDomain);
    if (!isValidDomain(rawDomain) || normalized.length > DOMAIN_MAX_LENGTH) {
      return fail(
        "domain",
        "Enter a website like example.com, or leave it empty.",
      );
    }
    domain = normalized;
  }

  // The client appends one "country" entry per market and the first one is the
  // primary market; getAll() keeps that order.
  const countries = [
    ...new Set(
      formData
        .getAll("country")
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (countries.length === 0) {
    return fail("country", "Choose where your customers are.");
  }
  if (countries.length > MAX_MARKETS) {
    return fail("country", `Choose at most ${MAX_MARKETS} markets.`);
  }
  const supported = countries.filter(isSupportedCountry);
  if (supported.length !== countries.length) {
    return fail("country", "Choose a market from the list.");
  }
  const [country] = supported;
  if (!country) return fail("country", "Choose where your customers are.");

  const language = textOf(formData, "language");
  if (!isSupportedLanguage(language)) {
    return fail("language", "Choose a content language from the list.");
  }

  const brandName = textOf(formData, "brandName");
  if (brandName.length > NAME_MAX_LENGTH) {
    return fail(
      "brandName",
      `Brand name is too long (${NAME_MAX_LENGTH} characters at most).`,
    );
  }

  const source = textOf(formData, "localeSource");
  return {
    ok: true,
    value: {
      name,
      ...(domain ? { domain } : {}),
      ...(brandName ? { brandName } : {}),
      language,
      countries: supported,
      country,
      ...(isLocaleSource(source) ? { localeSource: source } : {}),
    },
  };
}
