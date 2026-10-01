import {
  cleanPromptText,
  clipCodePoints,
  flatten,
  hostileShape,
} from "@/lib/guided-setup/sanitize";

// One short text that a model wrote (from facts, or from a web page it read)
// made safe to store and to put in a later prompt. A text that carries a link,
// a marker, a role label or an instruction is DROPPED whole (removing just the
// link would leave a meaningless fragment); anything else has its markup
// neutralized and is clipped to `max` characters.
export function safeModelText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const flat = flatten(raw);
  if (!flat) return null;
  if (hostileShape(clipCodePoints(flat, max * 4)) !== null) return null;
  return cleanPromptText(flat, max);
}

// A list of such texts: cleaned, de-duplicated (case-insensitive), at most `limit`.
export function safeModelList(
  raw: unknown,
  itemMax: number,
  limit: number,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = safeModelText(item, itemMax);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
