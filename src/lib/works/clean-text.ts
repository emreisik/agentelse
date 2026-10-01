// Cleaner for model-authored Works text (idea titles, captions, CTAs).
// Pure, isomorphic. Built only on the exports of guided-setup/sanitize.ts.
// Unlike safeModelText it REPAIRS marker characters and link tokens instead of
// dropping the whole text, so a hashtag or an @mention no longer kills an idea.

import {
  clipCodePoints,
  cleanPromptText,
  flatten,
  looksInstructionShaped,
} from "@/lib/guided-setup/sanitize";

export type CleanReason = "empty" | "instruction" | "unsafe";
export type CleanResult =
  { ok: true; text: string } | { ok: false; reason: CleanReason };

// Used when an idea's own title is not safe to quote back to the model.
export const NEUTRAL_IDEA_LABEL = "this idea";

const MIN_LENGTH = 2;

export function cleanWorksText(raw: unknown, max: number): CleanResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const flat = flatten(raw);
  if (!flat) return { ok: false, reason: "empty" };
  if (looksInstructionShaped(flat)) return { ok: false, reason: "instruction" };
  // Replaces marker characters, drops URL-shaped tokens, strips role labels.
  const cleaned = cleanPromptText(flat, max);
  if (cleaned === null) {
    // Marker-only input ("#") cleans to nothing: that is empty, not unsafe.
    const hasWord = /[\p{L}\p{N}]/u.test(flat);
    return { ok: false, reason: hasWord ? "unsafe" : "empty" };
  }
  if (Array.from(cleaned).length < MIN_LENGTH) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, text: cleaned };
}

export function cleanWorksTextOrNull(raw: unknown, max: number): string | null {
  const result = cleanWorksText(raw, max);
  return result.ok ? result.text : null;
}

// Model-readable sentence for tool errors that name a rejected string.
export function reasonSentence(reason: CleanReason): string {
  switch (reason) {
    case "instruction":
      return "it reads like an instruction";
    case "unsafe":
      return "it contains a link, a disguised word or unusual characters";
    case "empty":
      return "it is empty";
  }
}

// Brand rules, approved claims and competitor names are the client's own words
// handed to the model as quoted data: flattened and clipped, never judged
// (an instruction filter would drop "Never mention competitors by name").
export function flattenRuleText(raw: unknown, max = 120): string | null {
  if (typeof raw !== "string") return null;
  const text = flatten(raw);
  if (!text) return null;
  return clipCodePoints(text, max);
}
