// Static data for the AdSet wizard's targeting step (see
// src/components/ads/geo-target-select.tsx, gender-toggle.tsx). Country
// selection deliberately reuses SUPPORTED_COUNTRIES (src/lib/locales.ts) —
// the agency's own served markets — rather than a separate ~200-country
// Meta reference list; a project targeting outside these markets is out of
// scope for this wizard.

export const GENDER_OPTIONS = [
  { value: "" as const, label: "All" },
  { value: "1" as const, label: "Men" },
  { value: "2" as const, label: "Women" },
];

// Meta's numeric `locales` targeting ids (ad_locale, NOT ISO 639-1 —
// Facebook's own internal encoding). These values are commonly cited ones
// from Meta's locale reference but have NOT been cross-checked against a
// live Marketing API call — verify before relying on this for a production
// campaign; an incorrect id fails loudly (Meta rejects the request) rather
// than silently mistargeting.
export const META_LOCALES = [
  { id: 24, label: "Turkish" },
  { id: 6, label: "English (US)" },
  { id: 1002, label: "English (UK)" },
  { id: 23, label: "German" },
  { id: 16, label: "French" },
  { id: 15, label: "Spanish" },
  { id: 26, label: "Italian" },
  { id: 40, label: "Dutch" },
  { id: 34, label: "Russian" },
  { id: 13, label: "Arabic" },
  { id: 20, label: "Greek" },
  { id: 44, label: "Bulgarian" },
  { id: 67, label: "Romanian" },
  { id: 38, label: "Polish" },
] as const;

export type MetaLocaleId = (typeof META_LOCALES)[number]["id"];
