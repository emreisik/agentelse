import type { HeadlineZone } from "@/lib/layout-templates";

// Fitting a real photo of any shape into a post canvas (a feed post, a square,
// a landscape, a Story) without redrawing it: crop to the canvas's shape around
// the photo's subject, and when that would throw most of the photo away, show
// the whole photo over a blurred copy of itself instead. Pure, so the rules are
// testable; photo-fit.ts does the pixels.

// Below this share of the photo's area left in the crop, the whole photo is
// shown over a blurred background instead (a landscape photo on a Story).
export const EXTEND_BELOW_KEPT = 0.5;

export type Size = { width: number; height: number };
export type Crop = { left: number; top: number; width: number; height: number };

// The share of the photo's area a cover crop to this canvas keeps (0-1).
export function keptShare(photo: Size, canvas: Size): number {
  const p = photo.width / photo.height;
  const t = canvas.width / canvas.height;
  return p > t ? t / p : p / t;
}

export function fitMode(photo: Size, canvas: Size): "cover" | "extend" {
  return keptShare(photo, canvas) < EXTEND_BELOW_KEPT ? "extend" : "cover";
}

// Where in the crop window the subject should sit, as fractions of the window,
// so the post's headline gets the calm part of the picture. Only the slack the
// crop has can be used: a window with no room to slide stays where it is.
const ANCHOR: Record<HeadlineZone, { x: number; y: number }> = {
  TOP: { x: 0.5, y: 0.64 },
  UPPER_LEFT: { x: 0.62, y: 0.62 },
  CENTER: { x: 0.5, y: 0.5 },
  LEFT_COLUMN: { x: 0.68, y: 0.5 },
  BOTTOM: { x: 0.5, y: 0.38 },
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// The crop window, in the photo's own pixels.
export function planCoverCrop(input: {
  photo: Size;
  canvas: Size;
  // Where the main subject sits, 0-1 from the left / top (default: the centre).
  focal?: { x: number; y: number } | null;
  // Where the headline will be set.
  avoidZone?: HeadlineZone | null;
}): Crop {
  const { photo, canvas } = input;
  const p = photo.width / photo.height;
  const t = canvas.width / canvas.height;
  const width = Math.round(p > t ? photo.height * t : photo.width);
  const height = Math.round(p > t ? photo.height : photo.width / t);

  const focal = input.focal ?? { x: 0.5, y: 0.5 };
  const anchor = input.avoidZone ? ANCHOR[input.avoidZone] : ANCHOR.CENTER;
  const left = clamp(
    Math.round(focal.x * photo.width - anchor.x * width),
    0,
    photo.width - width,
  );
  const top = clamp(
    Math.round(focal.y * photo.height - anchor.y * height),
    0,
    photo.height - height,
  );
  return { left, top, width, height };
}
