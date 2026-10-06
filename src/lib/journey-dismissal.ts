import type { NextStep } from "@/lib/journey";

// "Hide for now" on the chat's next-step bar. Kept in the browser (a
// convenience, never state that matters): it hides what the client has seen,
// not what is new. A step comes back when it grows (more pieces waiting than
// when it was hidden), when a step that was not there appears, and in any case
// after a day, so a forgotten click can never bury something due.

export const DISMISS_TTL_MS = 24 * 60 * 60_000;

export type Dismissal = {
  // When it was hidden (ms).
  at: number;
  // Step key -> how many it covered when hidden.
  counts: Record<string, number>;
};

// How much a step is about: the pieces it covers. A step with nothing to count
// (connect a channel, plan the next weeks) is 1.
export function stepWeight(step: NextStep): number {
  const action = step.action;
  switch (action.kind) {
    case "produce_plan":
    case "review_queue":
    case "approve_plan":
    case "enable_scheduled_publish":
    case "show_results":
    case "fix_search_issue":
      return action.count;
    case "publish_manual":
      return action.creativeIds.length;
    default:
      return 1;
  }
}

function isLive(dismissal: Dismissal | null, now: number): dismissal is Dismissal {
  return dismissal !== null && now - dismissal.at < DISMISS_TTL_MS;
}

// The steps the client has not hidden: new ones, grown ones, and everything
// once the hiding has expired.
export function visibleSteps(
  steps: readonly NextStep[],
  dismissal: Dismissal | null,
  now: number,
): NextStep[] {
  if (!isLive(dismissal, now)) return [...steps];
  return steps.filter((step) => {
    const covered = dismissal.counts[step.key];
    return covered === undefined || stepWeight(step) > covered;
  });
}

// Hides `shown` (what the bar is showing right now). Earlier hiding that is
// still live is kept for the steps not on screen.
export function dismissSteps(
  shown: readonly NextStep[],
  previous: Dismissal | null,
  now: number,
): Dismissal {
  const counts = isLive(previous, now) ? { ...previous.counts } : {};
  for (const step of shown) counts[step.key] = stepWeight(step);
  return { at: now, counts };
}

// Whatever is in storage, read defensively: anything that is not a Dismissal
// is no dismissal.
export function parseDismissal(raw: string | null): Dismissal | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Dismissal> | null;
    if (
      !value ||
      typeof value.at !== "number" ||
      !value.counts ||
      typeof value.counts !== "object"
    ) {
      return null;
    }
    const counts: Record<string, number> = {};
    for (const [key, count] of Object.entries(value.counts)) {
      if (typeof count === "number") counts[key] = count;
    }
    return { at: value.at, counts };
  } catch {
    return null;
  }
}
