import { isValidDomain } from "@/lib/domain";
import {
  type LocaleDefault,
  type LocaleSource,
  countryForTld,
  languageForCountry,
} from "@/lib/locale-defaults";
import type { CountryCode, LanguageCode } from "@/lib/locales";
import { NAME_MAX_LENGTH } from "@/lib/project-create-input";

// Pure logic of the one-screen creation form. The component only renders this
// state and forwards events, so every rule that matters (a chip replaces the
// market, the language follows it, a missing market is an error and never a
// disabled button) can be tested without a DOM.

export type NewProjectField = "name" | "domain" | "country" | "language";

// Copy keys of copy.md section 8 (chrome stays English).
export const NEW_PROJECT_ERRORS = {
  name: "Enter a project name.",
  nameLong: "Project name is 120 characters at most.",
  domain: "Enter a valid website address (e.g. example.com).",
  country: "Pick where your customers are.",
  language: "Pick a content language.",
} as const;

export type NewProjectFocusTarget = "name" | "domain" | "market" | "language";

export type NewProjectState = {
  name: string;
  domain: string;
  brandName: string;
  // The first entry is the primary market (`Project.country`); the rest are
  // stored but display-only downstream.
  countries: CountryCode[];
  // Never set without a market unless the person picked it themselves.
  language: LanguageCode | null;
  // Once the person touches the language control it stops following the market.
  languageTouched: boolean;
  // Once the person taps a market it stops following the website address.
  marketTouched: boolean;
  // Provenance of the pre-selected market; null once the person chose.
  localeSource: LocaleSource | null;
  // What the server derived (previous project / browser), the fallback when the
  // typed website has no country signal.
  initial: LocaleDefault;
  errors: Partial<Record<NewProjectField, string>>;
  // Where focus moves after the last failed submit (the component moves it in
  // the submit handler, not in an effect).
  focus: NewProjectFocusTarget | null;
};

export function initialNewProjectState(
  initial: LocaleDefault,
): NewProjectState {
  return {
    name: "",
    domain: "",
    brandName: "",
    countries: initial ? [initial.country] : [],
    language: initial ? initial.language : null,
    languageTouched: false,
    marketTouched: false,
    localeSource: initial ? initial.source : null,
    initial,
    errors: {},
    focus: null,
  };
}

export type NewProjectAction =
  | { type: "name"; value: string }
  | { type: "domain"; value: string }
  | { type: "brandName"; value: string }
  // A chip tap: REPLACES the primary market (never appends).
  | { type: "tapMarket"; code: CountryCode }
  // The multi-select's whole list (first = primary).
  | { type: "setMarkets"; codes: CountryCode[] }
  | { type: "setLanguage"; code: LanguageCode }
  | { type: "submit" };

function withPrimary(
  state: NewProjectState,
  countries: CountryCode[],
): Pick<NewProjectState, "countries" | "language"> {
  const primary = countries[0];
  const changed = primary !== state.countries[0];
  // The language follows the market until the person touches it; with no
  // market and no own choice there is no language at all.
  const language =
    !state.languageTouched && changed
      ? primary
        ? languageForCountry(primary)
        : null
      : state.language;
  return { countries, language };
}

// The typed website may say where THIS brand sells (a ccTLD): it outranks the
// server's default but never the person's own tap.
function followDomain(state: NewProjectState, domain: string): NewProjectState {
  if (state.marketTouched) return { ...state, domain };
  const tld = domain.trim() ? countryForTld(domain) : null;
  const target: LocaleDefault = tld
    ? { country: tld, language: languageForCountry(tld), source: "tld" }
    : state.initial;
  return {
    ...state,
    domain,
    ...withPrimary(state, target ? [target.country] : []),
    localeSource: target ? target.source : null,
  };
}

// A language error goes away as soon as the language exists (the market just
// supplied it).
function errorsAfterMarket(
  state: NewProjectState,
  language: string | null,
): NewProjectState["errors"] {
  return {
    ...state.errors,
    country: undefined,
    language: language ? undefined : state.errors.language,
  };
}

export function newProjectReducer(
  state: NewProjectState,
  action: NewProjectAction,
): NewProjectState {
  switch (action.type) {
    case "name":
      return {
        ...state,
        name: action.value,
        errors: { ...state.errors, name: undefined },
      };
    case "domain": {
      const next = followDomain(state, action.value);
      return {
        ...next,
        errors: {
          ...state.errors,
          domain: undefined,
          country: next.countries.length ? undefined : state.errors.country,
          language: next.language ? undefined : state.errors.language,
        },
      };
    }
    case "brandName":
      return { ...state, brandName: action.value };
    case "tapMarket": {
      // Replaces the primary only: the extras (More markets) stay.
      const rest = state.countries
        .slice(1)
        .filter((code) => code !== action.code);
      const next = withPrimary(state, [action.code, ...rest]);
      return {
        ...state,
        ...next,
        marketTouched: true,
        // Tapping the pre-selected chip keeps its provenance; anything else is
        // the person's own choice.
        localeSource:
          action.code === state.countries[0] && !state.marketTouched
            ? state.localeSource
            : null,
        errors: errorsAfterMarket(state, next.language),
      };
    }
    case "setMarkets": {
      const codes = [...new Set(action.codes)];
      const next = withPrimary(state, codes);
      return {
        ...state,
        ...next,
        marketTouched: true,
        localeSource: null,
        errors: errorsAfterMarket(state, next.language),
      };
    }
    case "setLanguage":
      return {
        ...state,
        language: action.code,
        languageTouched: true,
        errors: { ...state.errors, language: undefined },
      };
    case "submit":
      return validateNewProject(state);
  }
}

// Validates on submit. The button is never disabled: a disabled button is
// skipped by keyboard and screen readers and could never show its own error.
// Every problem is shown; focus goes to the first one in visual order.
export function validateNewProject(state: NewProjectState): NewProjectState {
  const errors: NewProjectState["errors"] = {};
  const name = state.name.trim();
  if (!name) errors.name = NEW_PROJECT_ERRORS.name;
  else if (name.length > NAME_MAX_LENGTH) {
    errors.name = NEW_PROJECT_ERRORS.nameLong;
  }
  const domain = state.domain.trim();
  if (domain && !isValidDomain(domain)) {
    errors.domain = NEW_PROJECT_ERRORS.domain;
  }
  if (state.countries.length === 0) errors.country = NEW_PROJECT_ERRORS.country;
  // With no market there is no language either: the market error says it all.
  if (!state.language && state.countries.length > 0) {
    errors.language = NEW_PROJECT_ERRORS.language;
  }

  const focus: NewProjectFocusTarget | null = errors.name
    ? "name"
    : errors.domain
      ? "domain"
      : errors.country
        ? "market"
        : errors.language
          ? "language"
          : null;
  return { ...state, errors, focus };
}

export function isNewProjectValid(state: NewProjectState): boolean {
  return Object.keys(validateNewProject(state).errors).length === 0;
}

// The FormData the action reads: one "country" entry per market (first =
// primary), the derived language and the provenance of the default.
export function toNewProjectFormData(state: NewProjectState): FormData {
  const formData = new FormData();
  formData.set("name", state.name.trim());
  formData.set("domain", state.domain.trim());
  formData.set("brandName", state.brandName.trim());
  formData.set("language", state.language ?? "");
  for (const code of state.countries) formData.append("country", code);
  if (state.localeSource) formData.set("localeSource", state.localeSource);
  return formData;
}

// The visible provenance line under the chips (copy.md new.market.from.*).
export const LOCALE_SOURCE_LABEL: Record<LocaleSource, string> = {
  previous: "Same as your last project",
  tld: "From your website address",
  browser: "From your browser",
};

// Markets whose own language is not offered fall back to English, visibly
// (copy.md new.language.fallback names the missing language).
const UNSUPPORTED_LANGUAGE_NAME: Partial<Record<CountryCode, string>> = {
  RO: "Romanian",
  HR: "Croatian",
  PT: "Portuguese",
  PL: "Polish",
  SE: "Swedish",
  NO: "Norwegian",
  DK: "Danish",
};

// The fallback sentence, or null when nothing fell back: the market's language
// is offered, or the person chose the language themselves.
export function languageFallbackNote(state: NewProjectState): string | null {
  const country = state.countries[0];
  if (!country || state.languageTouched || state.language !== "en") return null;
  const missing = UNSUPPORTED_LANGUAGE_NAME[country];
  return missing
    ? `We don't write in ${missing} yet, so we'll use English.`
    : null;
}
