// Font family names as a website really writes them are often not the name of
// the font: next/font rewrites every family to a hashed one (`__Montserrat_0e8a88`)
// and adds a metrics-adjusted fallback beside it (`__Montserrat_Fallback_0e8a88`).
// A scan that picks those up would store names no font library knows. This
// turns them back into the family, and drops the fallbacks.

const NEXT_FONT = /^__(.+?)_([0-9a-f]{6,8})$/i;

export function normalizeFontName(raw: string): string | null {
  const name = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!name) return null;

  const hashed = NEXT_FONT.exec(name);
  if (hashed) {
    const inner = hashed[1]!;
    if (/_fallback$/i.test(inner)) return null;
    // A CSS variable name, not a family.
    if (/^variable(_|$)/i.test(inner)) return null;
    return inner.replace(/_/g, " ").trim() || null;
  }
  if (/\bfallback$/i.test(name)) return null;
  return name;
}

// A list of names cleaned and de-duplicated, in order (case-insensitively).
export function cleanFontList(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeFontName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
