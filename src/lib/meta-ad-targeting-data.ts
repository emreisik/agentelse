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
