// How big a logo is drawn on a post. A layout asks for a size as a percent of
// the canvas width, which on its own treats a 4:1 wordmark and a square emblem
// alike: the wordmark comes out thin and tiny, the emblem tall and heavy. The
// size is therefore read as "how much presence the logo gets" and turned into
// a box that fits the logo's own shape: roughly equal visual weight, never
// wider than a third of the post, never taller than an eighth of its short side,
// never so small it cannot be read. Pure, so the layouts and the compositor
// agree and the rules are testable.

// The proportions a layout's percent was designed around (a typical
// wordmark + mark lockup).
const REFERENCE_ASPECT = 2.2;
const MAX_WIDTH_RATIO = 0.32;
const MAX_HEIGHT_OF_SHORT_SIDE = 0.12;
const MIN_WIDTH_PX = 96;
const MIN_WIDTH_RATIO = 0.18;
// How strongly the shape bends the size: 0 ignores it (a plain percent of the
// width), 0.5 would give every logo the same area. In between, a wide wordmark
// is a little wider and a square emblem a little smaller than the reference.
const SHAPE_STRENGTH = 0.4;

export function fitLogoBox(input: {
  // Width / height of the trimmed logo.
  aspect: number;
  canvas: { width: number; height: number };
  // The layout's size, percent of the canvas width.
  sizePercent: number;
}): { width: number; height: number } {
  const { canvas } = input;
  const aspect =
    Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 1;
  const short = Math.min(canvas.width, canvas.height);

  const requested = (canvas.width * input.sizePercent) / 100;
  let width = requested * Math.pow(aspect / REFERENCE_ASPECT, SHAPE_STRENGTH);

  width = Math.min(width, canvas.width * MAX_WIDTH_RATIO);
  // Height cap: width follows from it for tall shapes.
  width = Math.min(width, short * MAX_HEIGHT_OF_SHORT_SIDE * aspect);
  // A readable floor, relaxed on a canvas too small to hold it and never above
  // the height cap (a square emblem on a landscape post).
  const floor = Math.min(
    MIN_WIDTH_PX,
    canvas.width * MIN_WIDTH_RATIO,
    short * MAX_HEIGHT_OF_SHORT_SIDE * aspect,
  );
  width = Math.max(width, floor);

  const w = Math.max(1, Math.round(width));
  return { width: w, height: Math.max(1, Math.round(w / aspect)) };
}
