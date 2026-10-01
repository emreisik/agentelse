"use client";

// Discovery sheet: the presentational half (spec section 8). Everything here is
// controlled: the shell owns the reducer, the poll and the handlers. No state,
// no effects. The Drawer title, description and close parts throw outside a
// Drawer root, so tests render through `<Drawer open>`; the Drawer itself
// (and its portal) belongs to the shell.

import type { ReactNode, Ref } from "react";
import Link from "next/link";
import {
  Check,
  Circle,
  CircleAlert,
  Loader2,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";

import { AgentelseMark } from "@/components/brand/agentelse-mark";
import {
  identityBlock,
  pendingCandidateIds,
  rowBlocks,
  stageLines,
  summaryLine,
  titleOf,
  type DiscoveryErrorCode,
  type DiscoveryState,
  type RowBlock,
  type StageLine,
} from "@/components/discovery/discovery-state";
import { Button } from "@/components/ui/button";
import {
  DrawerBody,
  DrawerClose,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import type { FailReason } from "@/lib/guided-discovery/contract";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// Copy (chrome is English; model text only ever appears as a quoted value)
// -----------------------------------------------------------------------------

const COPY = {
  closeAria: "Close and continue later",
  continueInChat: "Continue in chat",
  openChat: "Open chat",
  looksGood: "Looks good",
  saving: "Saving…",
  tryAgain: "Try again",
  starting: "Starting…",
  signIn: "Sign in",
  close: "Close",
  runningHelp: (host: string) =>
    `Reading ${host} and looking around the web. About a minute, and it keeps going if you close this.`,
  runningHelpNoHost:
    "Looking around the web. About a minute, and it keeps going if you close this.",
  readyHelp:
    "Everything below is saved. Tap + to add the suggestions you like, or add them all at once.",
  confirmedHelp: "Your workspace is set up. You can still add suggestions.",
  addAll: (count: number) => `Add all suggestions (${count})`,
  addingAll: "Adding…",
  rowEmpty: "Nothing found yet. You can add it later in Brand Brain.",
  readyEmpty:
    "We couldn't find much this time. Continue in chat and we'll build it together.",
  alsoFound: "Tap to add",
  alsoFoundAria: (label: string) => `Suggestions for ${label}`,
  chip: (text: string) => `+ ${text}`,
  addAria: (text: string) => `Add ${text}`,
  lookTitle: "Brand look",
  lookNone: "No logo, colors or fonts found yet.",
  lookLink: "Scan again in the Brand tab",
  failed: {
    limit: "Research is paused for today. You can keep going in chat.",
    busy: "A scan of this brand just ran. Try again in a few minutes.",
    timeout: "This took longer than expected.",
    error: "Something went wrong while looking into your brand.",
    unavailable: "Research isn't available right now.",
  } satisfies Record<FailReason, string>,
  errors: {
    SESSION: "Your session expired. Sign in again to continue.",
    DISABLED: "Setup isn't available for this project.",
    NETWORK: "Couldn't reach the server. Check your connection and try again.",
    TIMEOUT: "Couldn't reach the server. Check your connection and try again.",
    HTTP: "Something went wrong on our side. Try again.",
    EMPTY: "We haven't started on this brand yet.",
  } satisfies Record<DiscoveryErrorCode, string>,
} as const;

export const DISCOVERY_IDS = {
  title: "discovery-title",
  help: "discovery-help",
} as const;

const TEXT = "text-[color:var(--ws-text)]";
const TEXT_2 = "text-[color:var(--ws-text-2)]";
const RING =
  "focus-visible:ring-2 focus-visible:ring-[var(--ws-accent)] focus-visible:outline-none";
// Never a fixed height: a large system font grows the button instead of
// clipping its label.
const BTN = "h-auto min-h-11 whitespace-normal px-4 py-2 text-sm";
const PILL =
  "rounded-full border border-[var(--ws-border)] bg-[var(--ws-surface)] px-3 py-1 text-sm break-words";

// -----------------------------------------------------------------------------
// Parts
// -----------------------------------------------------------------------------

function StageIcon({ icon }: { icon: StageLine["icon"] }) {
  const cls = "size-4 shrink-0";
  switch (icon) {
    case "running":
      return (
        <Loader2
          aria-hidden="true"
          className={cn(cls, "animate-spin motion-reduce:animate-none")}
          style={{ color: "var(--ws-accent)" }}
        />
      );
    case "done":
      return (
        <Check
          aria-hidden="true"
          className={cls}
          style={{ color: "var(--ws-accent)" }}
        />
      );
    case "skipped":
      return <Minus aria-hidden="true" className={cn(cls, TEXT_2)} />;
    case "failed":
      return <TriangleAlert aria-hidden="true" className={cn(cls, TEXT)} />;
    default:
      return <Circle aria-hidden="true" className={cn(cls, TEXT_2)} />;
  }
}

function StageList({ lines }: { lines: StageLine[] }) {
  return (
    <ul className="divide-y divide-[var(--ws-border)]">
      {lines.map((line) => (
        <li key={line.stage} className="flex items-center gap-3 py-3 text-sm">
          <StageIcon icon={line.icon} />
          <span className={cn("min-w-0 flex-1 break-words", TEXT)}>
            {line.label}
          </span>
          <span className={cn("shrink-0 text-xs", TEXT_2)}>{line.word}</span>
        </li>
      ))}
    </ul>
  );
}

function TierTag({ row }: { row: RowBlock }) {
  const cls = "size-3.5 shrink-0";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        row.tier === "accepted" ? TEXT : TEXT_2,
      )}
    >
      {row.tier === "accepted" ? (
        <Check
          aria-hidden="true"
          className={cls}
          style={{ color: "var(--ws-accent)" }}
        />
      ) : row.tier === "assumed" ? (
        <CircleAlert aria-hidden="true" className={cls} />
      ) : (
        <Minus aria-hidden="true" className={cls} />
      )}
      {row.tierWord}
    </span>
  );
}

function RowView({
  row,
  onAdd,
}: {
  row: RowBlock;
  onAdd: (candidateId: string) => void;
}) {
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className={cn("text-sm font-medium", TEXT)}>{row.label}</h3>
        {row.showTier ? <TierTag row={row} /> : null}
      </div>
      {row.saved.length > 0 ? (
        row.kind === "text" ? (
          <p dir="auto" className={cn("mt-1 text-sm break-words", TEXT)}>
            {row.saved[0]}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {row.saved.map((text) => (
              <li key={text} dir="auto" className={cn(PILL, TEXT)}>
                {text}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {row.saved.length === 0 && row.candidates.length === 0 ? (
        <p className={cn("mt-1 text-sm", TEXT_2)}>{COPY.rowEmpty}</p>
      ) : null}
      {row.candidates.length > 0 ? (
        <div className="mt-2">
          <p className={cn("text-xs", TEXT_2)}>{COPY.alsoFound}</p>
          <div
            role="group"
            aria-label={COPY.alsoFoundAria(row.label)}
            className="mt-1.5 flex flex-wrap gap-2"
          >
            {row.candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                dir="auto"
                aria-label={COPY.addAria(candidate.text)}
                aria-busy={candidate.pending ? true : undefined}
                disabled={candidate.pending}
                onClick={() => onAdd(candidate.id)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-[var(--ws-border)] px-3.5 py-2 text-left text-sm break-words hover:bg-[var(--ws-hover)] disabled:opacity-60",
                  TEXT,
                  RING,
                )}
              >
                {candidate.pending ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                <span aria-hidden="true">
                  {candidate.pending
                    ? candidate.text
                    : COPY.chip(candidate.text)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function IdentityView({
  lines,
  brandHref,
  onClose,
}: {
  lines: string[];
  brandHref: string;
  onClose: () => void;
}) {
  return (
    <li className="py-3">
      <h3 className={cn("text-sm font-medium", TEXT)}>{COPY.lookTitle}</h3>
      {lines.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {lines.map((line) => (
            <li key={line} className={cn(PILL, TEXT)}>
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className={cn("mt-1 text-sm", TEXT_2)}>{COPY.lookNone}</p>
      )}
      <Link
        href={brandHref}
        onClick={onClose}
        className={cn(
          "mt-1 inline-flex min-h-11 items-center text-xs underline",
          TEXT_2,
          RING,
        )}
      >
        {COPY.lookLink}
      </Link>
    </li>
  );
}

function SkeletonBody() {
  return (
    <div aria-hidden="true" className="space-y-3 pt-1">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton
          key={i}
          className="h-12 rounded-xl motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function primaryButton(
  label: string,
  onClick: () => void,
  busy?: boolean,
): ReactNode {
  return (
    <Button
      type="button"
      className={cn(BTN, "w-full sm:w-auto")}
      disabled={busy}
      aria-busy={busy ? true : undefined}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function secondaryButton(label: string, onClick: () => void): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn(BTN, "w-full sm:w-auto")}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

export type DiscoveryPanelProps = {
  state: DiscoveryState;
  brandName: string;
  titleRef: Ref<HTMLHeadingElement>;
  // Where "Scan again" goes (the Brand tab) and where an expired session signs in.
  brandHref: string;
  loginHref: string;
  onAdd: (candidateId: string) => void;
  onAddAll: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onReload: () => void;
  onClose: () => void;
};

// The lead sentence under the title.
function helpOf(props: DiscoveryPanelProps): string {
  const { state } = props;
  const view = state.view;
  if (!view) {
    return state.phase === "error" && state.error
      ? COPY.errors[state.error]
      : "";
  }
  switch (view.status) {
    case "RUNNING":
      return view.host ? COPY.runningHelp(view.host) : COPY.runningHelpNoHost;
    case "READY":
      return COPY.readyHelp;
    case "CONFIRMED":
      return `${summaryLine(view)}. ${COPY.confirmedHelp}`;
    case "FAILED":
      return COPY.failed[view.failure ?? "error"];
  }
}

function Body(props: DiscoveryPanelProps): ReactNode {
  const { state, brandHref, onAdd, onClose } = props;
  const view = state.view;
  if (!view) {
    return state.phase === "loading" ? <SkeletonBody /> : null;
  }
  switch (view.status) {
    case "RUNNING":
    case "FAILED":
      return <StageList lines={stageLines(view)} />;
    case "READY":
    case "CONFIRMED": {
      const rows = rowBlocks(view, state.pendingAdd);
      const look = identityBlock(view.identity);
      const waiting = pendingCandidateIds(view).length;
      return (
        <>
          {rows.length === 0 ? (
            <p className={cn("text-sm", TEXT_2)}>{COPY.readyEmpty}</p>
          ) : null}
          {waiting > 0 ? (
            <div className="mb-2">
              <Button
                type="button"
                variant="outline"
                className={cn(BTN, "w-full sm:w-auto")}
                aria-disabled={state.pendingAdd.size > 0}
                onClick={props.onAddAll}
              >
                {state.pendingAdd.size > 0
                  ? COPY.addingAll
                  : COPY.addAll(waiting)}
              </Button>
            </div>
          ) : null}
          <ul className="divide-y divide-[var(--ws-border)]">
            {rows.map((row) => (
              <RowView key={row.field} row={row} onAdd={onAdd} />
            ))}
            <IdentityView
              lines={look?.lines ?? []}
              brandHref={brandHref}
              onClose={onClose}
            />
          </ul>
        </>
      );
    }
  }
}

function Footer(props: DiscoveryPanelProps): ReactNode {
  const { state, loginHref, onConfirm, onRetry, onReload, onClose } = props;
  const view = state.view;
  let actions: ReactNode = null;
  if (!view) {
    if (state.phase === "error") {
      if (state.error === "SESSION") {
        actions = (
          <Link
            href={loginHref}
            className={cn(
              "inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-[var(--ws-accent)] px-4 py-2 text-sm font-medium text-[color:var(--ws-on-accent)] sm:w-auto",
              RING,
            )}
          >
            {COPY.signIn}
          </Link>
        );
      } else {
        actions = (
          <>
            {secondaryButton(COPY.close, onClose)}
            {state.error !== "DISABLED" && state.error !== "EMPTY"
              ? primaryButton(COPY.tryAgain, onReload)
              : null}
          </>
        );
      }
    }
  } else {
    switch (view.status) {
      case "RUNNING":
        actions = primaryButton(COPY.continueInChat, onClose);
        break;
      case "READY":
        actions = primaryButton(
          state.busy === "confirm" ? COPY.saving : COPY.looksGood,
          onConfirm,
          state.busy === "confirm",
        );
        break;
      case "CONFIRMED":
        actions = primaryButton(COPY.openChat, onClose);
        break;
      case "FAILED":
        actions = (
          <>
            {secondaryButton(COPY.continueInChat, onClose)}
            {view.canRetry
              ? primaryButton(
                  state.busy === "retry" ? COPY.starting : COPY.tryAgain,
                  onRetry,
                  state.busy === "retry",
                )
              : null}
          </>
        );
        break;
    }
  }
  if (!actions) return null;
  return (
    <div className="flex shrink-0 flex-col-reverse gap-2 border-t px-5 pt-3 pb-3 sm:flex-row sm:justify-end">
      {actions}
    </div>
  );
}

export function DiscoveryPanel(props: DiscoveryPanelProps) {
  const { state, brandName, titleRef, onClose } = props;
  const title = titleOf(state.view, brandName);
  const help = helpOf(props);
  // A notice (a failed tap with the view still on screen) rides in the same
  // polite region as the stage announcements: there is exactly one.
  const notice =
    state.view && state.error ? COPY.errors[state.error] : state.announcement;
  return (
    <>
      <div className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-start gap-2">
          <AgentelseMark
            className="mt-1.5 size-4 shrink-0"
            style={{ color: "var(--ws-accent)" }}
          />
          <DrawerTitle
            ref={titleRef}
            id={DISCOVERY_IDS.title}
            tabIndex={-1}
            className={cn(
              "min-w-0 flex-1 text-lg leading-snug font-semibold break-words",
              TEXT,
            )}
          >
            {title}
          </DrawerTitle>
          <DrawerClose
            aria-label={COPY.closeAria}
            className={cn(
              "-mt-1 -mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--ws-hover)]",
              TEXT_2,
              RING,
            )}
          >
            <X aria-hidden="true" className="size-5" />
          </DrawerClose>
        </div>
        {/* Always present so the shell's aria-describedby id resolves. */}
        <DrawerDescription
          id={DISCOVERY_IDS.help}
          className={help ? cn("mt-1 text-sm break-words", TEXT_2) : "sr-only"}
        >
          {help}
        </DrawerDescription>
        <div role="status" aria-live="polite" className="sr-only">
          {notice}
        </div>
      </div>
      <DrawerBody className="px-5 pb-4">
        {state.view && state.error && state.error !== "EMPTY" ? (
          <p className={cn("mb-3 text-sm", TEXT)}>{COPY.errors[state.error]}</p>
        ) : null}
        <Body {...props} />
      </DrawerBody>
      <Footer {...props} onClose={onClose} />
    </>
  );
}
