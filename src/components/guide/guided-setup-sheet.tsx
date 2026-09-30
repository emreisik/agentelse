"use client";

import {
  startTransition,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useChatSend } from "@/components/commands/chat-send-context";
import {
  api,
  nextPollDelay,
  type ApiFailureKind,
} from "@/components/guide/guided-setup-client";
import { useGuidedSetup } from "@/components/guide/guided-setup-context";
import {
  GUIDED_SETUP_IDS,
  FOCUS_ATTR,
  GuidedSetupHeader,
  GuidedSetupPanel,
  type DraftState,
} from "@/components/guide/guided-setup-panel";
import {
  guidedSetupReducer,
  headerViewOf,
  initialModel,
  panelViewOf,
  runApprove,
  saveBody,
  summaryOf,
  type Action,
  type Model,
} from "@/components/guide/guided-setup-state";
import {
  POLL,
  SAVE_RETRY,
  type ApplyResult,
  type GuidedSetupHost,
  type GuidedSetupSummary,
} from "@/lib/guided-setup/contract";
import { applyGuidedSetupAction } from "@/server/actions/guided-setup-actions";

// The shell: everything with a clock, a network or a DOM (save queue, poll,
// approve, focus, toasts). Decisions live in guided-setup-state.ts; this file
// only wires them to the Drawer. No chat message is sent from here except the
// receipt's explicit "Draft my first plan" button.

// Closing waits this long for the save queue, then closes anyway: the queue
// keeps running in the background, so the person is never trapped.
export const CLOSE_WAIT_MS = 1_200;
const DRAFT_FAILED = "Couldn't draft the plan. Try again.";

type Client = ReturnType<typeof api>;

// A session bounce or a removed feature is not a network failure to retry.
function terminalAction(kind: ApiFailureKind): Action | null {
  if (kind === "SESSION") return { type: "expired" };
  if (kind === "NOT_FOUND" || kind === "DISABLED") {
    return { type: "unavailable" };
  }
  return null;
}

// Plain closure (no React): it owns the promise chain of the save queue, the
// in-flight Approve and the poll, and reads the latest committed Model through
// sync(). Created once per sheet. Exported for the shell test.
export function createController(deps: {
  initial: Model;
  client: Client;
  dispatch: (action: Action) => void;
  apply: (expectedRev: string) => Promise<ApplyResult>;
}) {
  const { client } = deps;
  let model = deps.initial;
  let open = false;
  let wasOpen = false;
  let alive = false;
  let ticket = 0;
  let chain: Promise<boolean> = Promise.resolve(true);
  let started: Promise<boolean> = Promise.resolve(true);
  let wake: (() => void) | null = null;
  let discovering = false;

  // React commits a dispatch (and runs the sync effect) only after the current
  // microtasks, but the save queue and Approve read `model` right after their
  // own dispatch: Approve must send the rev the save just returned, not the
  // previous one. So the controller applies the same pure reducer to its own
  // copy first; sync() then replaces it with the committed model.
  const dispatch = (action: Action) => {
    model = guidedSetupReducer(model, action);
    deps.dispatch(action);
  };

  // Sleeps, but an 'online' event cuts the wait short.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  async function runSave(mine: number, retry: boolean): Promise<boolean> {
    const session = await started;
    // Latest wins: a newer enqueue carries the newer answers.
    if (mine !== ticket) return true;
    // The session exists on the server already (a reopen) even if this
    // open's start failed.
    if (!session && model.rev === null) {
      dispatch({ type: "saveFailed" });
      return false;
    }
    for (let attempt = 0; ; attempt += 1) {
      if (model.phase === "expired" || model.phase === "unavailable") {
        return false;
      }
      const seq = model.editSeq;
      const result = await client.save(saveBody(model));
      if (result.ok) {
        dispatch({ type: "saved", response: result.data, seq });
        return true;
      }
      const terminal = terminalAction(result.kind);
      if (terminal) {
        dispatch(terminal);
        return false;
      }
      const delay = retry ? SAVE_RETRY.delaysMs[attempt] : undefined;
      if (delay === undefined || !alive) break;
      await sleep(delay);
      if (mine !== ticket) return true;
    }
    dispatch({ type: "saveFailed" });
    return false;
  }

  function enqueueSave(retry: boolean): Promise<boolean> {
    ticket += 1;
    const mine = ticket;
    // The chain never rejects: an unexpected throw is a failed save.
    chain = chain.then(async () => {
      try {
        return await runSave(mine, retry);
      } catch {
        dispatch({ type: "saveFailed" });
        return false;
      }
    });
    return chain;
  }

  // A failed queue gets one fresh attempt (no long backoff: the person is
  // waiting on it); otherwise it is whatever is already in flight.
  function flush(): Promise<boolean> {
    return model.save === "failed" ? enqueueSave(false) : chain;
  }

  function boot(reload: boolean, seedCommandId: string | undefined) {
    started = (async () => {
      const result = await client.start(seedCommandId);
      if (result.ok) {
        dispatch({ type: "hydrated", view: result.data, reload });
        return true;
      }
      dispatch(terminalAction(result.kind) ?? { type: "bootFailed" });
      return false;
    })();
  }

  const onOnline = () => {
    if (wake) wake();
    else if (model.save === "failed") void enqueueSave(true);
  };

  return {
    attach() {
      alive = true;
      window.addEventListener("online", onOnline);
      return () => {
        alive = false;
        window.removeEventListener("online", onOnline);
      };
    },

    // Called after every commit.
    sync(next: Model, isOpen: boolean) {
      model = next;
      open = isOpen;
    },

    // POST start once per open. A reopen with nothing unsaved takes the
    // server's state; otherwise the local answers win and a save follows.
    opened(isOpen: boolean, seedCommandId: string | undefined) {
      if (isOpen === wasOpen) return;
      wasOpen = isOpen;
      if (!isOpen) return;
      const settled =
        (model.phase === "ready" || model.phase === "done") &&
        model.save === "idle";
      boot(settled, seedCommandId);
    },

    reboot(reload: boolean, seedCommandId: string | undefined) {
      boot(reload, seedCommandId);
    },

    enqueueSave,
    flush,

    requestClose(close: () => void) {
      if (model.save === "idle") {
        close();
        return;
      }
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        close();
      };
      void flush().then(finish, finish);
      setTimeout(finish, CLOSE_WAIT_MS);
    },

    async discover() {
      if (discovering) return;
      discovering = true;
      try {
        if (!(await flush())) return;
        const result = await client.discover();
        if (result.ok) {
          dispatch({
            type: "ideasUpdated",
            ideas: result.data.ideas,
            from: "discover",
          });
        } else {
          dispatch(terminalAction(result.kind) ?? { type: "discoverFailed" });
        }
      } finally {
        discovering = false;
      }
    },

    // Approve: the save queue is flushed first; any throw (signed-out
    // redirect, deploy-skew "Failed to find Server Action") is an applyFailed,
    // so the sheet can never stay stuck in "applying".
    approve() {
      startTransition(async () => {
        try {
          await runApprove({
            getModel: () => model,
            dispatch,
            flush,
            apply: deps.apply,
            schedule: (ms, fn) => {
              const timer = setTimeout(fn, ms);
              return () => clearTimeout(timer);
            },
            isClosed: () => !open,
          });
        } catch {
          dispatch({ type: "applyFailed", code: "FAILED", closed: !open });
        }
      });
    },

    // Poll while ideas are RUNNING and the sheet is open. Hidden tabs skip the
    // tick (and their time does not count against POLL.maxMs), 429/5xx/network
    // back off silently, and it stops on a terminal state, after POLL.maxMs or
    // after POLL.maxConsecutiveFailures. Coming back to the tab polls once
    // right away, so a run that finished (or gave up) meanwhile shows at once.
    startPolling() {
      let stopped = false;
      let failures = 0;
      let inFlight = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startedAt = Date.now();
      let lastAt = startedAt;
      let hiddenMs = 0;
      const schedule = (ms: number) => {
        timer = setTimeout(() => void tick(), ms);
      };
      const tick = async () => {
        if (stopped || inFlight) return;
        const now = Date.now();
        if (document.hidden) hiddenMs += now - lastAt;
        lastAt = now;
        if (!document.hidden) {
          inFlight = true;
          let result: Awaited<ReturnType<Client["poll"]>>;
          try {
            result = await client.poll();
          } finally {
            inFlight = false;
          }
          if (stopped) return;
          if (result.ok) {
            failures = 0;
            dispatch({
              type: "ideasUpdated",
              ideas: result.data.ideas,
              from: "poll",
            });
            if (result.data.ideas.status !== "RUNNING") return;
          } else {
            const terminal = terminalAction(result.kind);
            if (terminal) {
              dispatch(terminal);
              return;
            }
            failures += 1;
          }
        }
        const delay = nextPollDelay({
          elapsedMs: Date.now() - startedAt - hiddenMs,
          status: "RUNNING",
          hidden: false,
          failures,
        });
        if (delay !== null) schedule(delay);
      };
      const onVisible = () => {
        if (document.hidden || stopped || inFlight) return;
        clearTimeout(timer);
        void tick();
      };
      document.addEventListener("visibilitychange", onVisible);
      schedule(POLL.intervalMs);
      return () => {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
}

// Which Drawer change reasons close the sheet. A backdrop tap never does (a
// stray tap would drop the person's place); Esc, X, swipe and the Android Back
// gesture all do, in every phase.
export function closesOn(reason: string): boolean {
  return (
    reason === "escape-key" ||
    reason === "close-press" ||
    reason === "swipe" ||
    reason === "close-watcher"
  );
}

function subscribeNoop() {
  return () => {};
}

// Focus returns to whatever opened the sheet if it is still on the page, else
// to the thread viewport. Never to the composer (it would open the keyboard).
export function makeFinalFocus(openerRef: RefObject<HTMLElement | null> | undefined) {
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

export type GuidedSetupSheetProps = {
  projectId: string;
  brandName: string;
  languageCode: string;
  chatEngine: "agent" | "legacy";
  host: GuidedSetupHost;
  // The chat message that asked for setup (the agent card); the server reads
  // the words from it.
  seedCommandId?: string;
  // Recorded by open() in the host: where focus returns on close.
  openerRef?: RefObject<HTMLElement | null>;
  // Keeps the chip and the "+" menu label in step with saves and apply.
  onSummary?: (summary: GuidedSetupSummary) => void;
};

export function GuidedSetupSheet({
  projectId,
  brandName,
  languageCode,
  chatEngine,
  host,
  seedCommandId,
  openerRef,
  onSummary,
}: GuidedSetupSheetProps) {
  const guided = useGuidedSetup();
  const send = useChatSend();
  const hydrated = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const [model, dispatch] = useReducer(
    guidedSetupReducer,
    {
      projectId,
      brandName,
      languageCode,
      host,
      canDraftPlan: chatEngine === "agent",
    },
    initialModel,
  );
  const [ctl] = useState(() =>
    createController({
      initial: model,
      client: api(projectId, (input, init) => fetch(input, init)),
      dispatch,
      apply: (expectedRev) => applyGuidedSetupAction(projectId, expectedRev),
    }),
  );
  const [draft, setDraft] = useState<DraftState>({
    status: "idle",
    error: null,
  });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const handledFocus = useRef(0);
  const shownToast = useRef(0);
  const lastSummary = useRef("");
  const drafting = useRef(false);

  // Opening is gated on hydration: a Drawer that is "open" at hydration is
  // never rendered on the server.
  const isOpen = (guided?.isOpen ?? false) && hydrated;
  const running = model.ideas?.status === "RUNNING";

  // Order matters: sync first, the others read what it stored.
  useEffect(() => {
    ctl.sync(model, isOpen);
  });
  useEffect(() => ctl.attach(), [ctl]);
  useEffect(() => {
    ctl.opened(isOpen, seedCommandId);
  }, [ctl, isOpen, seedCommandId]);
  useEffect(() => {
    if (model.editSeq > 0) void ctl.enqueueSave(true);
  }, [ctl, model.editSeq]);
  useEffect(() => {
    if (running && isOpen) return ctl.startPolling();
  }, [ctl, running, isOpen]);

  // The chip and the menu follow the session (only once the server answered).
  const summary = summaryOf(model);
  useEffect(() => {
    if (!model.view) return;
    const key = JSON.stringify(summary);
    if (key === lastSummary.current) return;
    lastSummary.current = key;
    onSummary?.(summary);
  });

  // A result that arrived while the sheet was closed: the only toast.
  useEffect(() => {
    const intent = model.toast;
    if (!intent || intent.seq === shownToast.current) return;
    shownToast.current = intent.seq;
    if (intent.kind === "saved") toast.success(intent.text);
    else toast.error(intent.text);
  }, [model.toast]);

  // One effect for every focus intent (the reducer bumps focus.seq).
  useEffect(() => {
    const { seq, target } = model.focus;
    if (handledFocus.current === seq) return;
    handledFocus.current = seq;
    if (!isOpen) return;
    const title = titleRef.current;
    const popup =
      title?.closest('[data-slot="drawer-content"]') ??
      document.querySelector('[data-slot="drawer-content"]');
    if (target === "title") {
      const body = title?.closest<HTMLElement>('[data-slot="drawer-body"]');
      if (body) body.scrollTop = 0;
      title?.focus({ preventScroll: true });
      return;
    }
    popup
      ?.querySelector<HTMLElement>(`[${FOCUS_ATTR}="${target}"]`)
      ?.focus({ preventScroll: true });
  }, [model.focus, isOpen]);

  if (!guided) return null;

  const close = guided.close;
  const requestClose = () => ctl.requestClose(close);
  const getIdeas = () => void ctl.discover();

  const draftPlan = async () => {
    if (!send || drafting.current) return;
    drafting.current = true;
    setDraft({ status: "pending", error: null });
    const result = await api(projectId, (input, init) =>
      fetch(input, init),
    ).draftPlan();
    drafting.current = false;
    if (!result.ok) {
      setDraft({ status: "idle", error: DRAFT_FAILED });
    } else if (!result.data.ok) {
      setDraft({ status: "idle", error: result.data.message });
    } else {
      setDraft({ status: "sent", error: null });
      close();
      // The agent's own plan flow drafts a card; nothing is saved until Save.
      send(result.data.message).catch(() => {});
    }
  };

  return (
    <Drawer
      open={isOpen}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        // outside-press and the rest: the sheet stays.
        if (!next && closesOn(details.reason)) requestClose();
      }}
    >
      <DrawerContent
        initialFocus={titleRef}
        finalFocus={makeFinalFocus(openerRef)}
        aria-labelledby={`${GUIDED_SETUP_IDS.header} ${GUIDED_SETUP_IDS.title}`}
        aria-describedby={GUIDED_SETUP_IDS.help}
      >
        <GuidedSetupHeader
          {...headerViewOf(model)}
          brandName={model.brand.name}
          languageCode={languageCode}
          onGetIdeas={getIdeas}
          onRetryIdeas={getIdeas}
        />
        <GuidedSetupPanel
          {...panelViewOf(model)}
          titleRef={titleRef}
          brandName={model.brand.name}
          languageCode={languageCode}
          direction={model.direction}
          settingsHref={`/projects/${encodeURIComponent(projectId)}/ayarlar`}
          connectHref={`/projects/${encodeURIComponent(projectId)}/integrations`}
          draft={draft}
          onPick={(id) => dispatch({ type: "pick", id })}
          onToggleOther={() => dispatch({ type: "toggleOther" })}
          onOtherText={(text) => dispatch({ type: "otherText", text })}
          onTier={() => dispatch({ type: "tier" })}
          onContinue={() => dispatch({ type: "next" })}
          onBack={() => dispatch({ type: "back" })}
          onSkip={() => dispatch({ type: "skip" })}
          onGoTo={(step) => dispatch({ type: "goTo", step })}
          onConfirmYes={() => dispatch({ type: "confirmYes" })}
          onConfirmNo={() => dispatch({ type: "confirmNo" })}
          onAddDetail={() => dispatch({ type: "addDetail" })}
          onReviewNow={() => dispatch({ type: "reviewNow" })}
          onShowSuggestions={() => dispatch({ type: "showSuggestions" })}
          onLook={() => dispatch({ type: "look" })}
          onRetryIdeas={getIdeas}
          onApprove={() => {
            setDraft({ status: "idle", error: null });
            ctl.approve();
          }}
          onRetrySave={() => void ctl.flush()}
          onReload={() => ctl.reboot(true, seedCommandId)}
          onRetryBoot={() => {
            dispatch({ type: "bootRetry" });
            ctl.reboot(false, seedCommandId);
          }}
          onClose={requestClose}
          onEditSetup={() => dispatch({ type: "editSetup" })}
          onDraftPlan={
            chatEngine === "agent" && send ? () => void draftPlan() : undefined
          }
        />
      </DrawerContent>
    </Drawer>
  );
}
