// Pure state and selectors of the discovery sheet. No React, no IO: the shell
// owns the clock and the network and only dispatches the results here.
import {
  FIELD_IDS,
  STAGES,
  type DiscoveryView,
  type FieldId,
  type IdentitySummary,
  type Stage,
  type StageState,
  type Tier,
} from "@/lib/guided-discovery/contract";
import type { DiscoveryFailureCode } from "@/components/discovery/discovery-client";

// -----------------------------------------------------------------------------
// Closed vocabulary (every sentence a selector can produce)
// -----------------------------------------------------------------------------

const WORDS = {
  titleRunning: (brand: string) => `Getting to know ${brand}`,
  titleReady: "Your brand profile",
  titleConfirmed: "Workspace ready",
  titleFailed: "Setup paused",
  brandFallback: "your brand",
  announceReady: "Your brand profile is ready.",
  announceFailed: "Setup stopped before it finished.",
  announceConfirmed: "Workspace ready.",
  summaryNothing: "Nothing found yet",
} as const;

const STAGE_LABEL: Record<Stage, string> = {
  site: "Reading your website",
  identity: "Finding logo, colors and fonts",
  research: "Researching your brand on the web",
  profile: "Writing your profile",
};

const STAGE_WORD: Record<StageState, string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  skipped: "Skipped",
  failed: "Couldn't finish",
};

const STAGE_DONE_SENTENCE: Record<Stage, string> = {
  site: "Website read.",
  identity: "Logo, colors and fonts found.",
  research: "Web research finished.",
  profile: "Profile written.",
};

const FIELD_LABEL: Record<FieldId, string> = {
  about: "About",
  audience: "Audience",
  products: "Products",
  services: "Services",
  markets: "Markets",
  voice: "Voice",
  positioning: "Positioning",
  competitors: "Competitors",
  channels: "Channels",
};

const TIER_WORD: Record<Tier, string> = {
  accepted: "Found",
  assumed: "Check",
  unknown: "Not found",
};

// Fields whose saved value is one sentence; the rest are lists.
const TEXT_FIELDS: ReadonlySet<FieldId> = new Set([
  "about",
  "voice",
  "positioning",
]);

// -----------------------------------------------------------------------------
// State and reducer
// -----------------------------------------------------------------------------

// `EMPTY`: the project has no discovery row (nothing to show).
export type DiscoveryErrorCode = DiscoveryFailureCode | "EMPTY";

export type Busy = "confirm" | "retry" | null;

export type DiscoveryState = {
  view: DiscoveryView | null;
  phase: "loading" | "ready" | "error";
  // Candidates whose add is in flight (the shell lets one run at a time).
  pendingAdd: ReadonlySet<string>;
  // With a view this is a one-line notice; without one the phase is "error".
  error: DiscoveryErrorCode | null;
  busy: Busy;
  // One closed-vocabulary sentence for the polite region; "" when none.
  announcement: string;
};

export type DiscoveryAction =
  | { type: "loadStarted" }
  | { type: "loaded"; view: DiscoveryView | null }
  | { type: "polled"; view: DiscoveryView | null }
  | { type: "addStarted"; candidateId: string }
  | { type: "addDone"; candidateId: string; view: DiscoveryView | null }
  | { type: "confirmStarted" }
  | { type: "confirmDone"; view: DiscoveryView | null }
  | { type: "retryStarted" }
  | {
      type: "failed";
      code: DiscoveryFailureCode;
      during: "load" | "poll" | "add" | "confirm" | "retry";
      candidateId?: string;
    };

export function initialState(
  initialView: DiscoveryView | null,
): DiscoveryState {
  return {
    view: initialView,
    phase: initialView ? "ready" : "loading",
    pendingAdd: new Set(),
    error: null,
    busy: null,
    announcement: "",
  };
}

// The rev changes on every write, but the stale-RUNNING -> FAILED read is
// derived from the clock and leaves it alone, so status is compared too.
function sameView(a: DiscoveryView | null, b: DiscoveryView): boolean {
  return (
    a !== null &&
    a.rev === b.rev &&
    a.status === b.status &&
    a.failure === b.failure &&
    a.canRetry === b.canRetry
  );
}

// A view replaces the old one. The same view keeps the old object so a quiet
// poll never re-renders. A null view (no row) never wipes a
// view we already have.
function withView(
  state: DiscoveryState,
  view: DiscoveryView | null,
  patch: Partial<DiscoveryState> = {},
): DiscoveryState {
  if (!view) {
    if (state.view) return { ...state, ...patch };
    return { ...state, ...patch, phase: "error", error: "EMPTY" };
  }
  const same = sameView(state.view, view);
  const announcement = same
    ? state.announcement
    : announcementOf(state.view, view);
  return {
    ...state,
    ...patch,
    view: same ? state.view : view,
    phase: "ready",
    error: patch.error ?? null,
    announcement,
  };
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function discoveryReducer(
  state: DiscoveryState,
  action: DiscoveryAction,
): DiscoveryState {
  switch (action.type) {
    case "loadStarted":
      return { ...state, phase: "loading", error: null };
    case "loaded":
      return withView(state, action.view, { busy: null });
    case "polled": {
      // Same data: keep the state object so a quiet poll never re-renders.
      if (
        action.view &&
        state.phase === "ready" &&
        sameView(state.view, action.view)
      ) {
        return state;
      }
      // A poll that lands while the person is mid-action keeps their busy flag.
      return { ...withView(state, action.view), busy: state.busy };
    }
    case "addStarted": {
      if (state.pendingAdd.has(action.candidateId)) return state;
      return {
        ...state,
        error: null,
        pendingAdd: new Set(state.pendingAdd).add(action.candidateId),
      };
    }
    case "addDone":
      return withView(state, action.view, {
        pendingAdd: without(state.pendingAdd, action.candidateId),
      });
    case "confirmStarted":
      return { ...state, busy: "confirm", error: null };
    case "confirmDone":
      return withView(state, action.view, { busy: null });
    case "retryStarted":
      return { ...state, busy: "retry", error: null };
    case "failed": {
      if (action.during === "poll") {
        // Polls fail silently except when the session or the feature is gone.
        if (action.code !== "SESSION" && action.code !== "DISABLED") {
          return state;
        }
      }
      const pendingAdd = action.candidateId
        ? without(state.pendingAdd, action.candidateId)
        : state.pendingAdd;
      return {
        ...state,
        pendingAdd,
        busy: null,
        error: action.code,
        phase: state.view ? "ready" : "error",
      };
    }
  }
}

// Whether a tap on "+" may start an add now: a known, unsaved candidate, and
// nothing else in flight (one at a time).
export function canAdd(state: DiscoveryState, candidateId: string): boolean {
  if (state.pendingAdd.size > 0) return false;
  if (state.view?.status === "FAILED") return false;
  return (state.view?.rows ?? []).some((row) =>
    row.candidates.some((c) => c.id === candidateId && !c.added),
  );
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

export function titleOf(
  view: DiscoveryView | null,
  brandName: string = "",
): string {
  const brand = view?.brandName || brandName || WORDS.brandFallback;
  switch (view?.status) {
    case "READY":
      return WORDS.titleReady;
    case "CONFIRMED":
      return WORDS.titleConfirmed;
    case "FAILED":
      return WORDS.titleFailed;
    default:
      return WORDS.titleRunning(brand);
  }
}

export type StageLine = {
  stage: Stage;
  // The icon kind is the state itself; the panel maps it to a glyph.
  icon: StageState;
  label: string;
  word: string;
};

export function stageLines(view: DiscoveryView): StageLine[] {
  return STAGES.map((stage) => ({
    stage,
    icon: view.stages[stage],
    label: STAGE_LABEL[stage],
    word: STAGE_WORD[view.stages[stage]],
  }));
}

export type CandidateBlock = { id: string; text: string; pending: boolean };

export type RowBlock = {
  field: FieldId;
  label: string;
  kind: "text" | "list";
  tier: Tier;
  tierWord: string;
  // Channels are plain labels: no tier word.
  showTier: boolean;
  saved: string[];
  candidates: CandidateBlock[];
};

export function rowBlocks(
  view: DiscoveryView,
  pendingAdd: ReadonlySet<string> = new Set(),
): RowBlock[] {
  const order = (field: FieldId) => FIELD_IDS.indexOf(field);
  return [...view.rows]
    .sort((a, b) => order(a.field) - order(b.field))
    .map((row) => {
      // An added candidate already sits in `saved`.
      const candidates = row.candidates
        .filter((c) => !c.added)
        .map((c) => ({
          id: c.id,
          text: c.text,
          pending: pendingAdd.has(c.id),
        }));
      return {
        field: row.field,
        label: FIELD_LABEL[row.field],
        kind: TEXT_FIELDS.has(row.field)
          ? ("text" as const)
          : ("list" as const),
        tier: row.tier,
        // A blank row with suggestions reads "Suggested", not "Not found".
        tierWord:
          row.saved.length === 0 &&
          candidates.length > 0
            ? "Suggested"
            : TIER_WORD[row.tier],
        showTier: row.field !== "channels",
        saved: [...row.saved],
        candidates,
      };
    });
}

// Every candidate still waiting for a tap (the "Add all" button's list).
export function pendingCandidateIds(view: DiscoveryView): string[] {
  return view.rows.flatMap((row) =>
    row.candidates.filter((c) => !c.added).map((c) => c.id),
  );
}

export type IdentityBlock = { lines: string[] };

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// Counts only: the view carries no raw colours, font names or images.
export function identityBlock(identity: IdentitySummary): IdentityBlock | null {
  if (!identity) return null;
  const lines: string[] = [];
  if (identity.logo) lines.push("Logo found");
  if (identity.colors > 0)
    lines.push(plural(identity.colors, "color", "colors"));
  if (identity.fonts > 0) lines.push(plural(identity.fonts, "font", "fonts"));
  if (identity.style) lines.push("Style noted");
  return lines.length > 0 ? { lines } : null;
}

// "7 things found · 2 to check". A row the person already took every
// suggestion of counts as found.
export function summaryLine(view: DiscoveryView): string {
  let found = 0;
  let toCheck = 0;
  for (const row of view.rows) {
    if (row.field === "channels") continue;
    if (row.tier === "accepted") found += 1;
    else if (row.tier === "assumed") {
      const open = row.candidates.some((c) => !c.added);
      if (open || row.saved.length === 0) toCheck += 1;
      else found += 1;
    }
  }
  const foundText = plural(found, "thing found", "things found");
  if (found === 0 && toCheck === 0) return WORDS.summaryNothing;
  if (toCheck === 0) return foundText;
  if (found === 0) return `${toCheck} to check`;
  return `${foundText} · ${toCheck} to check`;
}

// One sentence when something the person cares about changed; "" otherwise.
// Never on the first load (prev is null): opening a finished sheet is silent.
export function announcementOf(
  prev: DiscoveryView | null,
  next: DiscoveryView | null,
): string {
  if (!prev || !next) return "";
  if (prev.status !== next.status) {
    if (next.status === "READY") return WORDS.announceReady;
    if (next.status === "FAILED") return WORDS.announceFailed;
    if (next.status === "CONFIRMED") return WORDS.announceConfirmed;
    return "";
  }
  let latest: Stage | null = null;
  for (const stage of STAGES) {
    if (prev.stages[stage] !== "done" && next.stages[stage] === "done") {
      latest = stage;
    }
  }
  return latest ? STAGE_DONE_SENTENCE[latest] : "";
}
