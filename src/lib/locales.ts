// Language/country selected during project setup — determines which
// language and which market all AI research and reasoning calls focus on.
// Single source: both the <select> options and server action validation
// use this.

export const SUPPORTED_LANGUAGES = [
  { code: "tr", label: "Turkish" },
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "sq", label: "Albanian" },
  { code: "mk", label: "Macedonian" },
  { code: "sr", label: "Serbian" },
  { code: "bg", label: "Bulgarian" },
  { code: "el", label: "Greek" },
] as const;

export const SUPPORTED_COUNTRIES = [
  { code: "TR", label: "Turkey" },
  { code: "MK", label: "North Macedonia" },
  { code: "AL", label: "Albania" },
  { code: "XK", label: "Kosovo" },
  { code: "RS", label: "Serbia" },
  { code: "BG", label: "Bulgaria" },
  { code: "GR", label: "Greece" },
  { code: "RO", label: "Romania" },
  { code: "BA", label: "Bosnia and Herzegovina" },
  { code: "ME", label: "Montenegro" },
  { code: "HR", label: "Croatia" },
  { code: "DE", label: "Germany" },
  { code: "AT", label: "Austria" },
  { code: "CH", label: "Switzerland" },
  { code: "NL", label: "Netherlands" },
  { code: "BE", label: "Belgium" },
  { code: "FR", label: "France" },
  { code: "IT", label: "Italy" },
  { code: "ES", label: "Spain" },
  { code: "PT", label: "Portugal" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "PL", label: "Poland" },
  { code: "SE", label: "Sweden" },
  { code: "NO", label: "Norway" },
  { code: "DK", label: "Denmark" },
  { code: "AE", label: "United Arab Emirates" },
  { code: "SA", label: "Saudi Arabia" },
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];
export type CountryCode = (typeof SUPPORTED_COUNTRIES)[number]["code"];

// For continent-based quick market selection in the project setup wizard —
// just a UI shortcut with no backend counterpart: when selected, it expands
// into the concrete country codes in SUPPORTED_COUNTRIES.
export const COUNTRY_CONTINENTS: {
  id: string;
  label: string;
  countryCodes: CountryCode[];
}[] = [
  {
    id: "europe",
    label: "Europe",
    countryCodes: [
      "TR",
      "MK",
      "AL",
      "XK",
      "RS",
      "BG",
      "GR",
      "RO",
      "BA",
      "ME",
      "HR",
      "DE",
      "AT",
      "CH",
      "NL",
      "BE",
      "FR",
      "IT",
      "ES",
      "PT",
      "GB",
      "IE",
      "PL",
      "SE",
      "NO",
      "DK",
    ],
  },
  { id: "asia", label: "Asia (Middle East)", countryCodes: ["AE", "SA"] },
  { id: "north-america", label: "North America", countryCodes: ["US", "CA"] },
];

export function isSupportedLanguage(value: string): value is LanguageCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === value);
}

export function isSupportedCountry(value: string): value is CountryCode {
  return SUPPORTED_COUNTRIES.some((c) => c.code === value);
}

export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function countryLabel(code: string): string {
  return SUPPORTED_COUNTRIES.find((c) => c.code === code)?.label ?? code;
}
