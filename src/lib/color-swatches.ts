// Shared hex-color parsing — one implementation instead of the three
// independent reimplementations that existed before (brand-brain-panel.tsx's
// swatch display, creative-template.ts's accent-color extraction,
// brand-style-context.ts's typed BrandVisualIdentity fields). Defensive on
// purpose: color data arrives as loose Json (a single hex string, an array
// of hex strings, or an array of {hex,name} objects) — anything that
// doesn't parse is silently dropped rather than thrown on, since a
// malformed swatch entry shouldn't break prompt building or the panel.

export type ColorSwatch = { hex: string; name?: string };

const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function parseColorSwatches(value: unknown): ColorSwatch[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const swatches: ColorSwatch[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && HEX.test(entry)) {
      swatches.push({ hex: entry });
    } else if (entry && typeof entry === "object") {
      const hex = (entry as Record<string, unknown>).hex;
      const name = (entry as Record<string, unknown>).name;
      if (typeof hex === "string" && HEX.test(hex)) {
        swatches.push({
          hex,
          name: typeof name === "string" ? name : undefined,
        });
      }
    }
  }
  return swatches;
}

export function isValidHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}
