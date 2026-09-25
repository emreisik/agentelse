// approvedColors/approvedFonts (BrandDossier, BrandConstitution) is a
// free-form Json field (see creative-template.ts extractAccentColorHex) —
// these defensively convert a single hex string, a hex array, and a
// {hex,name} object array into a stable shape. Data that can't be parsed
// isn't silently dropped by callers: they fall back to showing the raw
// JSON instead (see brand-brain-panel.tsx's FieldGrid usage).
//
// Lives in lib (not a component file) because both UI panels and the
// server-only BrandTwin domain layer (src/server/brand-twin/) need it.

export type ColorSwatch = { hex: string; name?: string };

const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function isValidHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

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

export function parseFontNames(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      names.push(entry.trim());
    } else if (entry && typeof entry === "object") {
      const name =
        (entry as Record<string, unknown>).name ??
        (entry as Record<string, unknown>).family;
      if (typeof name === "string" && name.trim()) names.push(name.trim());
    }
  }
  return names;
}
