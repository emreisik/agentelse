// WCAG colour math for the Brand tab: which text colour is readable on a
// brand colour, and whether a background is dark enough to need the light
// logo variant. Pure and client-safe.

type Triplet = [number, number, number];

function toTriplet(hex: string): Triplet | null {
  let h = hex.trim().replace(/^#/, "").toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6); // ignore alpha
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

// WCAG relative luminance, 0 (black) .. 1 (white). An unparseable colour is
// treated as white: the safest assumption for "which text goes on top".
export function relativeLuminance(hex: string): number {
  const t = toTriplet(hex);
  if (!t) return 1;
  return 0.2126 * channel(t[0]) + 0.7152 * channel(t[1]) + 0.0722 * channel(t[2]);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// The point where white and black text have equal contrast (L ≈ 0.179):
// below it a background is "dark" (white content reads better on it).
const DARK_THRESHOLD = 0.179;

export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < DARK_THRESHOLD;
}

export const LIGHT_INK = "#ffffff";
export const DARK_INK = "#0b0b0b";

// Text / icon colour with the better contrast on the given background.
export function readableOn(hex: string): typeof LIGHT_INK | typeof DARK_INK {
  return isDarkColor(hex) ? LIGHT_INK : DARK_INK;
}
