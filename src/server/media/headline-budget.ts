import "server-only";

import type { TextPlacement } from "@/lib/layout-templates";
import { SCALE_SIZE, ZONE_WIDTH } from "@/server/media/creative-text";

// How much a post's headline can say. The typesetter sets the words at the
// layout's size and only shrinks long ones, so the room is a matter of the
// canvas, the zone, the scale and the line count; the writer is told the
// number instead of a blanket "six words", which is what made headlines
// fragments. Short still wins: past a point more words only weaken a hook.

// Average advance of Inter semi-bold with the display tracking, in ems.
const CHAR_EM = 0.54;
// Room left for word breaks and ragged line ends.
const FILL = 0.85;
const MIN_CHARS = 24;
const MAX_CHARS = 56;
const CHARS_PER_WORD = 6.5;

export type HeadlineBudget = {
  maxChars: number;
  minWords: number;
  maxWords: number;
};

export function headlineBudget(input: {
  placement: Pick<TextPlacement, "zone" | "scale" | "maxLines">;
  canvas: { width: number; height: number };
}): HeadlineBudget {
  const { placement, canvas } = input;
  const short = Math.min(canvas.width, canvas.height);
  const size = SCALE_SIZE[placement.scale] * short;
  const lineWidth = ZONE_WIDTH[placement.zone] * canvas.width;
  const perLine = lineWidth / (size * CHAR_EM);
  const maxChars = Math.max(
    MIN_CHARS,
    Math.min(MAX_CHARS, Math.round(perLine * placement.maxLines * FILL)),
  );
  const maxWords = Math.max(4, Math.min(9, Math.round(maxChars / CHARS_PER_WORD)));
  return { maxChars, minWords: Math.max(3, maxWords - 4), maxWords };
}
