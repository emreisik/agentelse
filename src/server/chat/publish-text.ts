// Caption and copy that a person will PUBLISH as written. The prompt cleaner
// (cleanWorksText) flattens line breaks, replaces '#' and drops link tokens:
// right for text that is quoted back to a model, wrong for a caption that goes
// live (dead hashtags, a broken sentence where a web address was). So this
// module keeps the author's words and layout, and still refuses whatever the
// prompt cleaner refuses (an instruction, a disguised word, a payload of
// combining marks): a '#' or a link in a caption never reaches a model prompt
// as itself, because the brief and title are built from the cleaned text.

import { clipCodePoints } from "@/lib/guided-setup/sanitize";
import {
  cleanWorksText,
  type CleanReason,
} from "@/lib/works/clean-text";

export type PublishTextResult =
  { ok: true; text: string } | { ok: false; reason: CleanReason };

// Controls (the line break is kept), lone surrogates and format characters.
// Joiners and variation selectors stay: emoji sequences need them.
const STRIP =
  /[\p{Cc}\p{Cs}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const EMOJI_GLUE = new Set(["\u200d", "\ufe0e", "\ufe0f"]);
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\p{Zl}\p{Zp}]/gu;

function keepLayout(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(LINE_BREAK, "\n")
    .replace(STRIP, (char) =>
      char === "\n" || EMOJI_GLUE.has(char) ? char : char === "\t" ? " " : "",
    )
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function cleanPublishText(raw: unknown, max: number): PublishTextResult {
  // The gate: same verdicts as every other model string in a Work.
  const gate = cleanWorksText(raw, max);
  if (!gate.ok) return gate;
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const text = clipCodePoints(keepLayout(raw), max);
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text };
}
