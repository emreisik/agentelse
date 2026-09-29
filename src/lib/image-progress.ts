// Progress of an image being generated live in the chat. The image API gives
// no percentage, only discrete milestones (start, up to 2 streamed previews,
// done), so the number shown is: the last milestone reached, plus a smooth
// time-based creep toward — never reaching — the next one. 100% is shown only
// once the render is truly finished.

export type ImageGenState = {
  // Date.now() when generation started.
  startedAt: number;
  // How many streamed previews have arrived (0-2).
  partials: number;
  done: boolean;
};

type Stage = { floor: number; cap: number; tauMs: number; label: string };

// floor = where a milestone puts the bar, cap = how far time alone may push
// it before the next milestone, tau = how quickly it creeps there.
const STAGES: Stage[] = [
  { floor: 4, cap: 38, tauMs: 12_000, label: "Preparing the scene" },
  { floor: 45, cap: 70, tauMs: 8_000, label: "Shaping the image" },
  { floor: 76, cap: 96, tauMs: 8_000, label: "Refining details" },
];

export function imageProgress(
  state: ImageGenState,
  now: number,
  // Where the bar was last shown: progress never moves backwards, even when
  // a milestone lands earlier than the time curve had already taken it.
  previousPct = 0,
): { pct: number; label: string } {
  if (state.done) return { pct: 100, label: "Done" };

  const stage = STAGES[Math.min(state.partials, STAGES.length - 1)]!;
  const elapsed = Math.max(0, now - state.startedAt);
  // Time since THIS stage began is unknown; approximating with total elapsed
  // is fine because the curve saturates toward `cap` either way.
  const creep = (stage.cap - stage.floor) * (1 - Math.exp(-elapsed / stage.tauMs));
  const pct = Math.min(
    stage.cap,
    Math.max(stage.floor, stage.floor + creep * 0.6),
  );
  return {
    pct: Math.floor(Math.max(previousPct, pct)),
    label: stage.label,
  };
}

// Blur radius (px) of the preview: heavy at the start, fully sharp at 100%.
export function previewBlurPx(pct: number): number {
  const remaining = Math.max(0, Math.min(100, 100 - pct)) / 100;
  return Math.round(28 * remaining * remaining * 10) / 10;
}
