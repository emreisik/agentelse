// Paylaşım ve beyaz etiket ortak türleri (SC-F9 ve GA-F8 ortak). Bu klasörde
// Search Console'a özgü bir şey yoktur; türe özgü çizim çizici kaydından geçer.

export type ShareKind = "SEARCH" | "WEBSITE";

export function isShareKind(value: unknown): value is ShareKind {
  return value === "SEARCH" || value === "WEBSITE";
}

export const ACCENT_KEYS = [
  "slate",
  "blue",
  "green",
  "violet",
  "orange",
  "rose",
] as const;

export type AccentKey = (typeof ACCENT_KEYS)[number];

export const ACCENT_HEX: Record<AccentKey, string> = {
  slate: "#475569",
  blue: "#2563eb",
  green: "#16a34a",
  violet: "#7c3aed",
  orange: "#ea580c",
  rose: "#e11d48",
};

export const ACCENT_LABEL: Record<AccentKey, string> = {
  slate: "Slate",
  blue: "Blue",
  green: "Green",
  violet: "Violet",
  orange: "Orange",
  rose: "Rose",
};

// Oluşturma anındaki marka; ReportShare.branding bunu saklar, sonradan marka
// değişse de gönderilmiş bağlantı değişmez.
export type BrandingSnapshot = {
  displayName: string;
  accent: AccentKey;
  footer: string | null;
  logoAssetId: string | null;
};

export const REPORT_SHARE_DAYS = [7, 30, 90] as const;
export const DEFAULT_SHARE_DAYS = 30;
export const MAX_ACTIVE_SHARES_PER_PROJECT = 50;

export const BRANDING_NAME_MAX = 60;
export const BRANDING_FOOTER_MAX = 160;

export const DEFAULT_SHARE_FOOTER = "Numbers from Google.";

export const LOGO_EMPTY_HINT =
  "No logo yet. Logos must be PNG, JPEG or WebP files saved as a LOGO asset in Brand Brain (SVG isn't served on public pages).";

// Genel sayfada yalnız bu görsel türleri sunulur; SVG asla (betik riski).
export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function isLogoMime(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (LOGO_MIME_TYPES as readonly string[]).includes(value)
  );
}
