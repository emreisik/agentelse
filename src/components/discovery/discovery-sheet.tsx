"use client";

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import {
  discoveryApi,
  nextPollDelay,
  type DiscoveryApi,
  type DiscoveryFailureCode,
} from "@/components/discovery/discovery-client";
import {
  DISCOVERY_IDS,
  DiscoveryPanel,
} from "@/components/discovery/discovery-panel";
import {
  canAdd,
  pendingCandidateIds,
  discoveryReducer,
  initialState,
  type DiscoveryAction,
  type DiscoveryState,
} from "@/components/discovery/discovery-state";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import type {
  DiscoveryStatus,
  DiscoveryView,
} from "@/lib/guided-discovery/contract";

// The shell: everything with a clock, a network or a DOM (poll, focus).
// Decisions live in discovery-state.ts; this file only wires them to the
// Drawer. Nothing paid starts from here except the explicit "Try again" tap,
// and no chat message is ever sent.

// Which Drawer change reasons hide the sheet. A backdrop tap never does (a
// stray tap would drop the person's place); Esc, X, swipe and the Android Back
// gesture all do. Closing only hides: the work on the server carries on.
export function closesOn(reason: string): boolean {
  return (
    reason === "escape-key" ||
    reason === "close-press" ||
    reason === "swipe" ||
    reason === "close-watcher"
  );
}

// Delay before the next poll, or null to stop: only while the sheet is open
// and the run is RUNNING, on top of the schedule of nextPollDelay.
export function pollDecision(input: {
  open: boolean;
  status: DiscoveryStatus | null;
  hidden: boolean;
  failures: number;
  elapsedMs: number;
}): number | null {
  if (!input.open || input.status !== "RUNNING") return null;
  return nextPollDelay(input.failures, input.hidden, input.elapsedMs);
}

// What one refresh found, for the poll loop.
export type RefreshOutcome = "running" | "settled" | "failed" | "terminal";

export type PollEnv = {
  hidden: () => boolean;
  now: () => number;
  onVisibility: (listener: () => void) => () => void;
};

const browserEnv: PollEnv = {
  hidden: () => document.hidden,
  now: () => Date.now(),
  onVisibility: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

// Plain closure (no React): it reads the latest state through its own copy of
// the pure reducer (a dispatch is committed by React later, but the next tap
// reads right away). Created once per sheet. Exported for the shell test.
export function createController(deps: {
  initial: DiscoveryState;
  client: DiscoveryApi;
  dispatch: (action: DiscoveryAction) => void;
}) {
  const { client } = deps;
  let state = deps.initial;
  // Bumped whenever a write finishes: a read that started earlier may carry
  // an older view and must not overwrite it.
  let writes = 0;
  let writesInFlight = 0;

  const dispatch = (action: DiscoveryAction) => {
    state = discoveryReducer(state, action);
    deps.dispatch(action);
  };

  async function write(
    call: () => ReturnType<DiscoveryApi["confirm"]>,
    done: (view: DiscoveryView | null) => DiscoveryAction,
    failed: (code: DiscoveryFailureCode) => DiscoveryAction,
  ) {
    writesInFlight += 1;
    try {
      const result = await call();
      writes += 1;
      dispatch(result.ok ? done(result.view) : failed(result.code));
    } finally {
      writesInFlight -= 1;
    }
  }

  // A read: the first load, the refresh on open and every poll.
  async function refresh(): Promise<RefreshOutcome> {
    const startedAt = writes;
    const during = state.view ? "poll" : "load";
    const result = await client.get();
    if (writesInFlight > 0 || writes !== startedAt) return "running";
    if (!result.ok) {
      dispatch({ type: "failed", code: result.code, during });
      return result.code === "SESSION" || result.code === "DISABLED"
        ? "terminal"
        : "failed";
    }
    dispatch({ type: state.view ? "polled" : "loaded", view: result.view });
    return result.view?.status === "RUNNING" ? "running" : "settled";
  }

  return {
    getState: () => state,
    refresh,

    add(candidateId: string) {
      if (!canAdd(state, candidateId)) return Promise.resolve();
      dispatch({ type: "addStarted", candidateId });
      return write(
        () => client.add(candidateId),
        (view) => ({ type: "addDone", candidateId, view }),
        (code) => ({ type: "failed", code, during: "add", candidateId }),
      );
    },

    // One tap adds every suggestion, one after the other (each is its own
    // id-only write, so a failure leaves the rest untouched).
    async addAll() {
      const view = state.view;
      if (!view || state.busy) return;
      for (const candidateId of pendingCandidateIds(view)) {
        if (!canAdd(state, candidateId)) continue;
        await this.add(candidateId);
        if (state.error) break;
      }
    },

    confirm() {
      if (state.busy || state.view?.status !== "READY")
        return Promise.resolve();
      dispatch({ type: "confirmStarted" });
      return write(
        () => client.confirm(),
        (view) => ({ type: "confirmDone", view }),
        (code) => ({ type: "failed", code, during: "confirm" }),
      );
    },

    retry() {
      if (state.busy || !state.view?.canRetry) return Promise.resolve();
      dispatch({ type: "retryStarted" });
      return write(
        () => client.retry(),
        (view) => ({ type: "loaded", view }),
        (code) => ({ type: "failed", code, during: "retry" }),
      );
    },

    // The error screen's Try again: one fresh read.
    async reload() {
      dispatch({ type: "loadStarted" });
      const result = await client.get();
      dispatch(
        result.ok
          ? { type: "loaded", view: result.view }
          : { type: "failed", code: result.code, during: "load" },
      );
    },

    // Poll while the run is RUNNING and the sheet is open. Hidden tabs stop
    // (and their time does not count against the 5 minute cap), failures back
    // off silently, and coming back to the tab refreshes once right away, so a
    // run that finished meanwhile shows at once.
    startPolling(env: PollEnv = browserEnv) {
      let stopped = false;
      let failures = 0;
      let inFlight = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startedAt = env.now();
      let hiddenMs = 0;
      let hiddenSince: number | null = env.hidden() ? startedAt : null;
      const elapsed = () => {
        const now = env.now();
        const hiddenNow = hiddenSince === null ? 0 : now - hiddenSince;
        return now - startedAt - hiddenMs - hiddenNow;
      };
      const tick = async () => {
        if (stopped || inFlight || env.hidden()) return;
        inFlight = true;
        let outcome: RefreshOutcome;
        try {
          outcome = await refresh();
        } finally {
          inFlight = false;
        }
        if (stopped || outcome === "settled" || outcome === "terminal") return;
        failures = outcome === "failed" ? failures + 1 : 0;
        const delay = pollDecision({
          open: true,
          status: "RUNNING",
          hidden: env.hidden(),
          failures,
          elapsedMs: elapsed(),
        });
        if (delay !== null) timer = setTimeout(() => void tick(), delay);
      };
      const onVisibility = () => {
        if (stopped) return;
        const now = env.now();
        if (env.hidden()) {
          if (hiddenSince === null) hiddenSince = now;
          clearTimeout(timer);
          return;
        }
        if (hiddenSince !== null) {
          hiddenMs += now - hiddenSince;
          hiddenSince = null;
        }
        clearTimeout(timer);
        void tick();
      };
      const off = env.onVisibility(onVisibility);
      timer = setTimeout(() => void tick(), nextPollDelay(0, false, 0) ?? 0);
      return () => {
        stopped = true;
        clearTimeout(timer);
        off();
      };
    },
  };
}

function subscribeNoop() {
  return () => {};
}

// Focus returns to whatever opened the sheet if it is still on the page, else
// to the thread viewport. Never to the composer (it would open the keyboard).
export function makeFinalFocus(
  openerRef: RefObject<HTMLElement | null> | undefined,
) {
  return (): HTMLElement | false => {
    const opener = openerRef?.current;
    if (opener?.isConnected) return opener;
    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="aui_thread-viewport"]',
    );
    if (!viewport) return false;
    viewport.tabIndex = -1;
    return viewport;
  };
}

export type DiscoverySheetProps = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView: DiscoveryView | null;
  brandName: string;
  // Where focus returns on close.
  openerRef?: RefObject<HTMLElement | null>;
};

export function DiscoverySheet({
  projectId,
  open,
  onOpenChange,
  initialView,
  brandName,
  openerRef,
}: DiscoverySheetProps) {
  // Opening is gated on hydration: a Drawer that is "open" at hydration is
  // never rendered on the server.
  const hydrated = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const [state, dispatch] = useReducer(
    discoveryReducer,
    initialView,
    initialState,
  );
  const [ctl] = useState(() =>
    createController({
      initial: state,
      client: discoveryApi(projectId, (input, init) => fetch(input, init)),
      dispatch,
    }),
  );
  const titleRef = useRef<HTMLHeadingElement>(null);

  const isOpen = open && hydrated;
  const running = state.view?.status === "RUNNING";

  // One refresh per open: a view that changed while the sheet was closed (or
  // a first load with no view) shows at once. It is a read, never paid.
  useEffect(() => {
    if (isOpen) void ctl.refresh();
  }, [ctl, isOpen]);
  useEffect(() => {
    if (isOpen && running) return ctl.startPolling();
  }, [ctl, isOpen, running]);

  return (
    <Drawer
      open={isOpen}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && closesOn(details.reason)) onOpenChange(false);
      }}
    >
      <DrawerContent
        initialFocus={titleRef}
        finalFocus={makeFinalFocus(openerRef)}
        aria-labelledby={DISCOVERY_IDS.title}
        aria-describedby={DISCOVERY_IDS.help}
      >
        <DiscoveryPanel
          state={state}
          brandName={brandName}
          titleRef={titleRef}
          brandHref={buildHubHref(projectId, {
            panel: "brand-brain",
            sub: "visual-identity",
          })}
          loginHref={`/login?callbackUrl=${encodeURIComponent(
            `/projects/${projectId}?guide=setup`,
          )}`}
          onAdd={(candidateId) => void ctl.add(candidateId)}
          onAddAll={() => void ctl.addAll()}
          onConfirm={() => void ctl.confirm()}
          onRetry={() => void ctl.retry()}
          onReload={() => void ctl.reload()}
          onClose={() => onOpenChange(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}
