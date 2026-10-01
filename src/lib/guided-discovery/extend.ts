import { safeModelText } from "@/lib/safe-model-text";
import type { DiscoveryExtendOutput } from "@/server/reasoning/prompts/discovery-extend";

import {
  DISCOVERY_CAPS,
  TIER_LIMITS,
  type Candidate,
  type FieldId,
  type Row,
} from "./contract";
import { tierOf } from "./tiers";

// Pure merge of the extension call into the stored rows. Rules: nothing below
// 60 is kept; a high-confidence item is written only into an EMPTY list; a
// non-empty list changes only by a tap, so everything else becomes a candidate.

export type ExtendField =
  "services" | "products" | "markets" | "visualGuidelines";
export type DossierWrites = Partial<Record<ExtendField, string[]>>;

const FIELDS: readonly ExtendField[] = [
  "services",
  "products",
  "markets",
  "visualGuidelines",
];
const ITEM_MAX = 70;
const SCORE_CAP = 90; // the model only inferred these: never "certain"

// Rows that must not stay blank: suggestions only (never auto-saved), kept from
// a lower score than the rest and capped below "accepted".
export type FillField = "about" | "voice" | "positioning" | "audience";
const FILL_FIELDS: readonly FillField[] = [
  "about",
  "voice",
  "positioning",
  "audience",
];
const FILL_MIN_SCORE = 50;
const FILL_MAX_SCORE = 84;
const FILL_TEXT_MAX = 140;
const FILL_ITEMS: Record<FillField, number> = {
  about: 3,
  voice: 3,
  positioning: 3,
  audience: 6,
};

type Kept = { text: string; score: number };

function keptItems(
  raw: DiscoveryExtendOutput[ExtendField],
  taken: Set<string>,
): Kept[] {
  const out: Kept[] = [];
  for (const item of raw) {
    const text = safeModelText(item.text, ITEM_MAX);
    if (!text) continue;
    const score = Number.isFinite(item.score)
      ? Math.round(Math.min(Math.max(item.score, 0), 100, SCORE_CAP))
      : 0;
    if (score < TIER_LIMITS.assumed) continue;
    const key = text.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ text, score });
  }
  // Best first (stable), so the per-row cap drops the weakest.
  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .map(({ item }) => item);
}

// The fill lists are optional for callers that predate them.
type ExtendInput = Omit<DiscoveryExtendOutput, FillField> &
  Partial<Pick<DiscoveryExtendOutput, FillField>>;

function fillItems(
  raw: { text: string; score: number }[],
  field: FillField,
  taken: Set<string>,
): Kept[] {
  const out: Kept[] = [];
  const max = field === "audience" ? ITEM_MAX : FILL_TEXT_MAX;
  for (const item of raw) {
    const text = safeModelText(item.text, max);
    if (!text) continue;
    const score = Number.isFinite(item.score)
      ? Math.round(Math.min(Math.max(item.score, 0), FILL_MAX_SCORE))
      : 0;
    if (score < FILL_MIN_SCORE) continue;
    const key = text.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ text, score });
  }
  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .map(({ item }) => item)
    .slice(0, FILL_ITEMS[field]);
}

export function mergeExtension(
  rows: Row[],
  out: ExtendInput,
  makeId: (field: FieldId, text: string) => string,
): { rows: Row[]; dossierWrites: DossierWrites } {
  const next: Row[] = rows.map((row) => ({
    ...row,
    saved: [...row.saved],
    candidates: row.candidates.map((c) => ({ ...c })),
  }));
  const dossierWrites: DossierWrites = {};

  for (const field of FIELDS) {
    const index = next.findIndex((row) => row.field === field);
    const row = index >= 0 ? next[index] : null;
    const taken = new Set<string>();
    for (const text of row?.saved ?? []) taken.add(text.toLowerCase());
    for (const c of row?.candidates ?? []) taken.add(c.text.toLowerCase());

    const kept = keptItems(out[field] ?? [], taken);
    if (kept.length === 0) continue;

    const listEmpty = (row?.saved.length ?? 0) === 0;
    const writes: Kept[] = [];
    const extra: Kept[] = [];
    for (const item of kept) {
      if (listEmpty && item.score >= TIER_LIMITS.accepted) writes.push(item);
      else extra.push(item);
    }

    if (field === "visualGuidelines") {
      // No row: only confident items are kept, and only as a dossier write.
      if (writes.length > 0) {
        dossierWrites.visualGuidelines = writes.map((w) => w.text);
      }
      continue;
    }

    const room = Math.max(
      0,
      DISCOVERY_CAPS.maxCandidatesPerRow - (row?.candidates.length ?? 0),
    );
    const added: Candidate[] = extra.slice(0, room).map((item) => ({
      id: makeId(field, item.text),
      text: item.text,
      score: item.score,
      added: false,
    }));
    if (writes.length === 0 && added.length === 0) continue;
    if (writes.length > 0) dossierWrites[field] = writes.map((w) => w.text);

    const best = Math.max(...[...writes, ...extra].map((i) => i.score));
    if (row) {
      row.candidates.push(...added);
      if (writes.length > 0) {
        row.saved = writes.map((w) => w.text);
        row.score = Math.max(row.score, best);
        row.tier = tierOf(row.score);
      }
    } else {
      const score =
        writes.length > 0 ? Math.max(...writes.map((w) => w.score)) : best;
      next.push({
        field,
        tier: tierOf(score),
        score,
        saved: writes.map((w) => w.text),
        candidates: added,
      });
    }
  }

  // Suggestions for the rows that would otherwise stay blank. A text row that
  // already holds an accepted value needs none.
  for (const field of FILL_FIELDS) {
    const index = next.findIndex((row) => row.field === field);
    const row = index >= 0 ? next[index] : null;
    if (field !== "audience" && row && row.saved.length > 0) continue;
    const taken = new Set<string>();
    for (const text of row?.saved ?? []) taken.add(text.toLowerCase());
    for (const c of row?.candidates ?? []) taken.add(c.text.toLowerCase());
    const room = Math.max(
      0,
      DISCOVERY_CAPS.maxCandidatesPerRow - (row?.candidates.length ?? 0),
    );
    const kept = fillItems(out[field] ?? [], field, taken).slice(0, room);
    if (kept.length === 0) continue;
    const added: Candidate[] = kept.map((item) => ({
      id: makeId(field, item.text),
      text: item.text,
      score: item.score,
      added: false,
    }));
    if (row) {
      row.candidates.push(...added);
    } else {
      const score = Math.max(...kept.map((item) => item.score));
      next.push({
        field,
        tier: tierOf(score),
        score,
        saved: [],
        candidates: added,
      });
    }
  }

  return { rows: next, dossierWrites };
}
