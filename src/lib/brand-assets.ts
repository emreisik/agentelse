// BrandDossier's targetAudiences/markets/products/services columns are
// free-form Json (see project-actions.ts parseDossierJsonField): a plain
// string[] from the constitution synthesis, a {label|name|title, description}[]
// from the seed, or whatever a person typed in the edit sheet. The Assets tab
// shows them as a readable list; a shape that fits neither returns null so
// the caller keeps the raw JSON visible instead of dropping data.

export type AssetItem = { title: string; detail?: string };

const TITLE_KEYS = ["label", "name", "title", "segment", "audience"] as const;
const DETAIL_KEYS = ["description", "detail", "summary", "note"] as const;

function firstText(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseAssetItems(value: unknown): AssetItem[] | null {
  if (value === null || value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  const items: AssetItem[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry.trim()) items.push({ title: entry.trim() });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const title = firstText(record, TITLE_KEYS);
      if (!title) return null;
      items.push({ title, detail: firstText(record, DETAIL_KEYS) });
    } else {
      return null;
    }
  }
  return items;
}

export type AssetReadinessKey =
  "logo" | "positioning" | "tone" | "colors" | "fonts" | "audience";

export const ASSET_READINESS_LABEL: Record<AssetReadinessKey, string> = {
  logo: "Logo",
  positioning: "Positioning",
  tone: "Tone of voice",
  colors: "Colors",
  fonts: "Fonts",
  audience: "Audience",
};

// Which of the brand's core assets are filled in — the checklist at the top of
// the Assets tab. A missing one is a to-do the tab can point at.
export function assetReadiness(input: {
  hasLogo: boolean;
  positioning: string | null | undefined;
  toneOfVoice: string | null | undefined;
  colorCount: number;
  fontCount: number;
  audienceCount: number;
}): { key: AssetReadinessKey; done: boolean }[] {
  const filled = (text: string | null | undefined) => !!text?.trim();
  return [
    { key: "logo", done: input.hasLogo },
    { key: "positioning", done: filled(input.positioning) },
    { key: "tone", done: filled(input.toneOfVoice) },
    { key: "colors", done: input.colorCount > 0 },
    { key: "fonts", done: input.fontCount > 0 },
    { key: "audience", done: input.audienceCount > 0 },
  ];
}
