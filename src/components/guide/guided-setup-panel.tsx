"use client";

// Guided setup: the presentational half of the bottom sheet (spec 3.1, 3.5, 3.6,
// 6.4, 6.5). Everything here is controlled: the shell owns the reducer and hands
// in the views of guided-setup-state.ts plus handlers. No state, no effects; the
// only refs are the ones the shell uses to move focus.
//
// The Drawer title, description and close parts throw outside a Drawer root, so
// they live in this file and every test renders through a `<Drawer open>` helper.
// There is no portal here: the Drawer (and its portal) belongs to the shell.

import type { KeyboardEvent, ReactNode, Ref } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Rocket, X } from "lucide-react";

import { AgentelseMark } from "@/components/brand/agentelse-mark";
import { Button } from "@/components/ui/button";
import {
  DrawerBody,
  DrawerClose,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  RECEIPT_PART_LABELS,
  type ApplyPart,
  type QuestionId,
  type ReviewChip,
  type ReviewRow,
  type StepId,
} from "@/lib/guided-setup/contract";
import type {
  HeaderView,
  IdeasLineView,
  InlineView,
  PanelView,
  RowView,
  SegmentState,
  StripView,
} from "@/components/guide/guided-setup-state";

// -----------------------------------------------------------------------------
// Copy (copy.md; chrome is English, AI text is only ever a quoted value)
// -----------------------------------------------------------------------------

const COPY = {
  closeAria: "Close and continue later",
  back: "Back",
  continue: "Continue",
  tryAgain: "Try again",
  close: "Close",
  suggested: "Suggested",
  counter: (n: number, max: number) => `${n} of ${max} picked`,
  maxHint: (max: number) => `You can pick up to ${max}`,
  bootAria: "Getting your setup ready",
  otherDefault: "Something else…",
  otherRule: "Add your own rule…",
  quote: (text: string) => `“${text}”`,
  // Ideas line
  offerTitle: (host: string) => `Ideas from ${host} and the web`,
  offerTitleNoHost: "Ideas from the web",
  offerBody:
    "About a minute, uses a little AI credit. It saves a first draft of your brand profile from what it finds; you can change it.",
  offerNoSite: "Ideas from the web are limited without a website.",
  offerSeed: "Based on what you told us:",
  offerButton: "Get ideas",
  noInput: "Answer the first question and we can look for ideas.",
  retryFailed: "We couldn't gather ideas this time.",
  busy: "A scan of this brand just ran. Try again in a few minutes.",
  limit: "Ideas are paused for today. Answer with the options below.",
  exhausted:
    "Ideas aren't available for this brand right now. Answer with the options below.",
  mock: "Suggestions from the web aren't available right now.",
  running: (host: string) => `Reading ${host} and searching the web…`,
  runningNoHost: "Searching the web…",
  slow: "Still working. You can keep answering, ideas will appear here.",
  readyProfile: "From your brand profile",
  readyDiscovery: (host: string) => `From ${host} and the web`,
  readyDiscoveryNoHost: "From the web",
  stripEmpty: (brand: string) =>
    `We didn't find anything specific for ${brand}. Pick from the options below.`,
  stripNone: (brand: string) => `No specific suggestions found for ${brand}.`,
  bannerReady: "Suggestions are ready",
  bannerShow: "Show",
  catchup: "Suggestions are ready.",
  // Business
  tierMore: "More types",
  tierLess: "Common types",
  confirmYes: "Yes, that's right",
  confirmNo: "Not quite",
  // Checkpoint
  checkpointTitle: "That's enough to get started.",
  checkpointHelp:
    "Add more detail for better first results, or review and start now.",
  checkpointReview: "Review and start",
  checkpointMore: "Add more detail",
  checkpointMore2: "2 more questions, about a minute",
  checkpointMore1: "1 more question, about 30 seconds",
  suggestionsFor: (questions: string) =>
    `Suggestions are ready for: ${questions}`,
  look: "Look",
  // Review
  reviewTitle: "Here is your setup",
  reviewHelp: "Your answers are saved when you approve.",
  reviewHelpDiscovery:
    "The draft profile from the web is already saved; your answers replace the matching parts.",
  reviewSaved:
    "Your setup is saved. Change anything below, then approve again.",
  skippedAll:
    "You skipped everything. Your team will start with what it already knows.",
  skipped: "Skipped",
  delegated: "You decide",
  unanswered: "Not answered",
  current: (value: string) => `Current: ${value}`,
  edit: "Edit",
  editAria: (question: string) => `Edit: ${question}`,
  doesHeading: "What approving does",
  handsOn: (name: string, note: string) =>
    `Hands-on level: ${name} (${note}). Change it in Settings.`,
  never:
    "Approving itself publishes nothing, connects no account and spends nothing.",
  approve: "Approve and start",
  approveSaving: "Saving your answers…",
  hintEmpty: "Answer at least one question to save",
  hintUnchanged: "Nothing changed since you saved",
  applying: "Saving your setup…",
  applyingSlow:
    "This is taking longer than usual. You can close this, your setup keeps saving.",
  // Done
  doneTitle: "Setup saved",
  goal: (goal: string) => `Goal: ${goal}`,
  goalProposed: (goal: string) =>
    `Goal: ${goal} (waiting for your approval in Strategy)`,
  channels: (channels: string) => `Channels: ${channels}`,
  saved: (parts: string) => `Saved: ${parts}`,
  plan: "Draft my first plan",
  planHelp: "You review the plan before anything is saved.",
  planPending: "Drafting…",
  connect: "Connect accounts",
  editSetup: "Edit setup",
  // Errors and edge states
  errorBoot: "We couldn't open setup.",
  errorDisabled: "Guided setup isn't available.",
  errorExpired:
    "Your session expired. Sign in again to continue. Your progress is saved.",
  signIn: "Sign in",
  errorSaveFailed:
    "Couldn't save your answers. Check your connection, then try again.",
  errorStale: "This setup changed in another tab.",
  reload: "Reload setup",
  errorPaused:
    "This project is paused. You can answer now; approving needs it active.",
  settings: "Settings",
  errorOnHold: "This project is paused. Resume it first, then approve.",
  errorBusy: "Your setup is being saved. Give it a moment.",
  errorFailed: "Couldn't save your setup. Try again.",
  errorRate: "You've saved this setup many times today. Try again tomorrow.",
  pickCleared: "Your earlier pick isn't in the suggestions, so it was cleared.",
  partial: (saved: string, failed: string) =>
    saved
      ? `Some parts couldn't be saved. Saved: ${saved}. Not saved: ${failed}.`
      : `Some parts couldn't be saved. Not saved: ${failed}.`,
} as const;

// Placeholders of the "Something else" field, per question.
const OTHER_PLACEHOLDER: Record<QuestionId, string> = {
  goal: "",
  channels: "",
  business: "Describe it in a few words",
  audience: "Describe who you want to reach",
  tone: "Describe the voice in a few words",
  angle: "One sentence is enough",
  guardrails: "Write it as an instruction",
};

const REVIEW_ROW_LABEL: Record<QuestionId, string> = {
  goal: "Goal",
  channels: "Channels",
  business: "Business",
  audience: "Audience",
  tone: "Voice",
  angle: "Positioning",
  guardrails: "Rules",
};

// The question behind an Edit button (aria-label "Edit: {question}").
const questionTitleOf = (q: QuestionId, brand: string): string => {
  switch (q) {
    case "goal":
      return "What matters most right now?";
    case "channels":
      return "Where should we show up?";
    case "business":
      return `What kind of business is ${brand}?`;
    case "audience":
      return "Who do you want to reach?";
    case "tone":
      return `How should ${brand} sound?`;
    case "angle":
      return `What should people remember about ${brand}?`;
    case "guardrails":
      return `Anything ${brand} should never do?`;
  }
};

// Ids the shell wires into the dialog: aria-labelledby = header + title,
// aria-describedby = help. One sheet is open at a time.
export const GUIDED_SETUP_IDS = {
  header: "guided-setup-header",
  title: "guided-setup-title",
  help: "guided-setup-help",
  approveHint: "guided-setup-approve-hint",
} as const;

// Elements a focus intent (Model.focus) can name besides the title: the shell
// finds them with `[data-guided-focus="other"]` and so on.
export const FOCUS_ATTR = "data-guided-focus";

// -----------------------------------------------------------------------------
// Shared bits
// -----------------------------------------------------------------------------

const TEXT = "text-[color:var(--ws-text)]";
const TEXT_2 = "text-[color:var(--ws-text-2)]";
const RING =
  "focus-visible:ring-2 focus-visible:ring-[var(--ws-accent)] focus-visible:outline-none";
// Never a fixed height: a large system font grows the button instead of
// clipping its label.
const BTN = "h-auto min-h-11 whitespace-normal px-4 py-2 text-sm";

function AiText({
  ai,
  lang,
  children,
}: {
  ai: boolean;
  lang: string;
  children: string;
}) {
  return ai ? (
    <span lang={lang} dir="auto">
      {children}
    </span>
  ) : (
    <>{children}</>
  );
}

function SuggestedTag() {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-[var(--ws-border)] px-2 py-0.5 text-[11px] leading-4",
        TEXT_2,
      )}
    >
      {COPY.suggested}
    </span>
  );
}

function Heading({
  titleRef,
  title,
  help,
  hideTitle,
}: {
  titleRef: Ref<HTMLHeadingElement>;
  title: string;
  help?: string;
  hideTitle?: boolean;
}) {
  return (
    <>
      <DrawerTitle
        ref={titleRef}
        id={GUIDED_SETUP_IDS.title}
        tabIndex={-1}
        className={cn(
          "text-lg leading-snug font-semibold break-words",
          TEXT,
          hideTitle && "sr-only",
        )}
      >
        {title}
      </DrawerTitle>
      {/* Always present so the shell's aria-describedby id resolves. */}
      <DrawerDescription
        id={GUIDED_SETUP_IDS.help}
        className={help ? cn("mt-1 text-sm", TEXT_2) : "sr-only"}
      >
        {help}
      </DrawerDescription>
    </>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          aria-hidden="true"
          className="h-12 rounded-xl motion-reduce:animate-none"
        />
      ))}
    </>
  );
}

// -----------------------------------------------------------------------------
// Inline messages (never toasts while the sheet is open)
// -----------------------------------------------------------------------------

function InlineAlert({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "mx-5 mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--ws-border)] bg-[var(--ws-surface-2)] px-3 py-2 text-sm",
        TEXT,
      )}
    >
      <p className="min-w-0 flex-1 break-words">{children}</p>
      {action}
    </div>
  );
}

const partLabels = (parts: readonly ApplyPart[] | undefined): string =>
  (parts ?? []).map((p) => RECEIPT_PART_LABELS[p]).join(", ");

type InlineHandlers = {
  onRetrySave: () => void;
  onReload: () => void;
  onApprove: () => void;
  onRetryIdeas: () => void;
};

function inlineMessage(inline: InlineView): string {
  switch (inline.kind) {
    case "saveFailed":
      return COPY.errorSaveFailed;
    case "stale":
      return COPY.errorStale;
    case "onHold":
      return COPY.errorOnHold;
    case "busy":
      return COPY.errorBusy;
    case "rate":
      return COPY.errorRate;
    case "failed":
      return COPY.errorFailed;
    case "discover":
      return COPY.retryFailed;
    case "pickCleared":
      return COPY.pickCleared;
    case "paused":
      return COPY.errorPaused;
    case "partial":
      return COPY.partial(partLabels(inline.saved), partLabels(inline.failed));
  }
}

// Which handler the notice's button runs, and what it says.
function inlineAction(
  inline: InlineView,
  h: InlineHandlers,
): { label: string; run: () => void } | null {
  if (inline.retry !== true) return null;
  switch (inline.kind) {
    case "saveFailed":
      return { label: COPY.tryAgain, run: h.onRetrySave };
    case "stale":
      return { label: COPY.reload, run: h.onReload };
    case "partial":
    case "failed":
      return { label: COPY.tryAgain, run: h.onApprove };
    case "discover":
      return { label: COPY.tryAgain, run: h.onRetryIdeas };
    default:
      return null;
  }
}

// The alert above the footer. "paused" is a note at the top of the body instead.
function InlineSlot({
  inline,
  h,
}: {
  inline: InlineView | null;
  h: InlineHandlers;
}) {
  if (!inline || inline.kind === "paused") return null;
  const action = inlineAction(inline, h);
  return (
    <InlineAlert
      action={
        action ? (
          <Button
            type="button"
            variant="outline"
            className={BTN}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ) : null
      }
    >
      {inlineMessage(inline)}
    </InlineAlert>
  );
}

function PausedNote({
  inline,
  settingsHref,
}: {
  inline: InlineView | null;
  settingsHref?: string;
}) {
  if (inline?.kind !== "paused") return null;
  return (
    <p
      className={cn(
        "mb-3 rounded-lg border border-[var(--ws-border)] bg-[var(--ws-surface-2)] px-3 py-2 text-sm",
        TEXT,
      )}
    >
      {COPY.errorPaused}{" "}
      {settingsHref ? (
        <Link href={settingsHref} className="font-medium underline">
          {COPY.settings}
        </Link>
      ) : null}
    </p>
  );
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

const SEGMENT_CLASS: Record<SegmentState, string> = {
  done: "bg-[var(--ws-accent)]",
  current: "bg-[var(--ws-accent)]/50",
  todo: "bg-[var(--ws-border)]",
};

function Segments({ segments }: { segments: HeaderView["segments"] }) {
  return (
    <div aria-hidden="true" className="mt-3 flex items-center gap-1.5">
      {segments.main.map((state, i) => (
        <span
          key={`m${i}`}
          className={cn("h-1 flex-1 rounded-full", SEGMENT_CLASS[state])}
        />
      ))}
      {segments.detail.length > 0 ? <span className="w-1.5 shrink-0" /> : null}
      {segments.detail.map((state, i) => (
        <span
          key={`d${i}`}
          className={cn(
            "h-1 w-8 shrink-0 rounded-full opacity-70",
            SEGMENT_CLASS[state],
          )}
        />
      ))}
    </div>
  );
}

function IdeasLineBody({
  line,
  brandName,
  languageCode,
  onGetIdeas,
  onRetryIdeas,
}: {
  line: NonNullable<IdeasLineView>;
  brandName: string;
  languageCode: string;
  onGetIdeas: () => void;
  onRetryIdeas: () => void;
}) {
  switch (line.kind) {
    case "offer":
      return (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className={cn("min-w-0 text-sm font-medium break-words", TEXT)}>
              {line.host ? COPY.offerTitle(line.host) : COPY.offerTitleNoHost}
            </p>
            <Button
              type="button"
              variant="outline"
              className={cn(BTN, "shrink-0")}
              onClick={onGetIdeas}
            >
              {COPY.offerButton}
            </Button>
          </div>
          <p className={cn("mt-1 text-xs", TEXT_2)}>{COPY.offerBody}</p>
          {line.noSite ? (
            <p className={cn("mt-1 text-xs", TEXT_2)}>{COPY.offerNoSite}</p>
          ) : null}
          {line.seed ? (
            <p className={cn("mt-1 text-xs break-words", TEXT_2)}>
              {COPY.offerSeed} {"“"}
              <span lang={languageCode} dir="auto">
                {line.seed}
              </span>
              {"”"}
            </p>
          ) : null}
        </>
      );
    case "retry":
      return (
        <div className="flex items-start justify-between gap-3">
          <p className={cn("min-w-0 text-sm break-words", TEXT)}>
            {COPY.retryFailed}
          </p>
          <Button
            type="button"
            variant="outline"
            className={cn(BTN, "shrink-0")}
            onClick={onRetryIdeas}
          >
            {COPY.tryAgain}
          </Button>
        </div>
      );
    case "running":
      return (
        <>
          <p className={cn("flex items-start gap-2 text-sm", TEXT)}>
            <Loader2
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
            <span className="min-w-0 break-words">
              {line.host ? COPY.running(line.host) : COPY.runningNoHost}
            </span>
          </p>
          {line.slow ? (
            <p className={cn("mt-1 text-xs", TEXT_2)}>{COPY.slow}</p>
          ) : null}
        </>
      );
    case "ready":
      return (
        <p className={cn("text-sm break-words", TEXT)}>
          {line.empty
            ? COPY.stripNone(brandName)
            : line.source === "profile"
              ? COPY.readyProfile
              : line.host
                ? COPY.readyDiscovery(line.host)
                : COPY.readyDiscoveryNoHost}
        </p>
      );
    case "note":
      return (
        <p className={cn("text-sm break-words", TEXT_2)}>
          {line.note === "no_input"
            ? COPY.noInput
            : line.note === "busy"
              ? COPY.busy
              : line.note === "limit"
                ? COPY.limit
                : line.note === "exhausted"
                  ? COPY.exhausted
                  : COPY.mock}
        </p>
      );
  }
}

// ONE persistent slot under the progress segments, on every step. Its minimum
// height reserves the space of the largest state (the offer) so the rows below
// do not jump when the line changes. `null` (research off) renders no slot.
function IdeasLine(props: {
  line: IdeasLineView;
  brandName: string;
  languageCode: string;
  onGetIdeas: () => void;
  onRetryIdeas: () => void;
}) {
  if (props.line === null) return null;
  return (
    <div
      tabIndex={-1}
      {...{ [FOCUS_ATTR]: "strip" }}
      className={cn(
        "mt-3 min-h-[4.75rem] rounded-lg border border-[var(--ws-border)] px-3 py-2 select-text",
        RING,
      )}
    >
      <IdeasLineBody {...props} line={props.line} />
    </div>
  );
}

export type GuidedSetupHeaderProps = HeaderView & {
  // The client's own brand name (used by the "nothing found" line).
  brandName: string;
  // Language of AI-derived text (`Project.language`).
  languageCode: string;
  onGetIdeas: () => void;
  onRetryIdeas: () => void;
};

// Owned by the shell (a sibling of the panel inside the Drawer popup). The ONE
// polite status region lives here, outside the keyed step container, so it is
// never re-created per step. Close is a DrawerClose: the shell's onOpenChange
// flushes the save queue and closes.
export function GuidedSetupHeader({
  title,
  segments,
  ideasLine,
  announcement,
  brandName,
  languageCode,
  onGetIdeas,
  onRetryIdeas,
}: GuidedSetupHeaderProps) {
  return (
    <div className="relative shrink-0 touch-none px-5 pt-3 pb-3 select-none">
      <div
        aria-hidden="true"
        className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-border"
      />
      <div className="flex items-center gap-2 pt-2">
        <AgentelseMark
          className="size-4 shrink-0"
          style={{ color: "var(--ws-accent)" }}
        />
        <span
          id={GUIDED_SETUP_IDS.header}
          className={cn("min-w-0 flex-1 truncate text-sm font-semibold", TEXT)}
        >
          {title}
        </span>
        <DrawerClose
          aria-label={COPY.closeAria}
          className={cn(
            "-mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--ws-hover)]",
            TEXT_2,
            RING,
          )}
        >
          <X aria-hidden="true" className="size-5" />
        </DrawerClose>
      </div>
      <Segments segments={segments} />
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <IdeasLine
        line={ideasLine}
        brandName={brandName}
        languageCode={languageCode}
        onGetIdeas={onGetIdeas}
        onRetryIdeas={onRetryIdeas}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Question step
// -----------------------------------------------------------------------------

function OptionRow({
  row,
  lang,
  onPick,
}: {
  row: RowView;
  lang: string;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={row.selected}
      aria-disabled={row.disabled ? true : undefined}
      onClick={row.disabled ? undefined : () => onPick(row.id)}
      className={cn(
        "flex min-h-12 w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left break-words whitespace-normal transition-colors",
        RING,
        row.selected
          ? "border-[var(--ws-accent)] bg-[var(--ws-surface-2)] forced-colors:border-[Highlight]"
          : "border-[var(--ws-border)] bg-[var(--ws-surface)] hover:bg-[var(--ws-hover)]",
        row.disabled &&
          "cursor-not-allowed opacity-50 hover:bg-[var(--ws-surface)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
          row.selected
            ? "border-[var(--ws-accent)] bg-[var(--ws-accent)] text-[color:var(--ws-on-accent)] forced-colors:border-[Highlight]"
            : "border-[var(--ws-border)]",
        )}
      >
        {row.selected ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium",
            TEXT,
          )}
        >
          <AiText ai={row.ai} lang={lang}>
            {row.label}
          </AiText>
          {row.ai ? <SuggestedTag /> : null}
        </span>
        {row.hint ? (
          <span className={cn("mt-0.5 block text-xs", TEXT_2)}>{row.hint}</span>
        ) : null}
      </span>
    </button>
  );
}

// What Enter does in the typed field: a phone keeps the keyboard's Done
// (blur, the person then taps Continue), a desktop keyboard continues when the
// text is valid.
export function otherEnterAction(
  coarsePointer: boolean,
  canContinue: boolean,
): "blur" | "continue" | "none" {
  if (coarsePointer) return "blur";
  return canContinue ? "continue" : "none";
}

function OtherField({
  question,
  title,
  other,
  lang,
  disabledAtMax,
  canContinue,
  onToggleOther,
  onOtherText,
  onContinue,
}: {
  question: QuestionId;
  title: string;
  other: { open: boolean; text: string; max: number };
  lang: string;
  disabledAtMax: boolean;
  canContinue: boolean;
  onToggleOther: () => void;
  onOtherText: (text: string) => void;
  onContinue: () => void;
}) {
  const label = question === "guardrails" ? COPY.otherRule : COPY.otherDefault;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const coarse =
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches;
    const action = otherEnterAction(coarse, canContinue);
    if (action === "blur") e.currentTarget.blur();
    else if (action === "continue") onContinue();
  };
  const blocked = disabledAtMax && !other.open;
  return (
    <div>
      <button
        type="button"
        aria-pressed={other.open}
        aria-disabled={blocked ? true : undefined}
        {...{ [FOCUS_ATTR]: "otherRow" }}
        onClick={blocked ? undefined : onToggleOther}
        className={cn(
          "flex min-h-12 w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-sm font-medium break-words whitespace-normal",
          TEXT,
          RING,
          other.open
            ? "border-[var(--ws-accent)] bg-[var(--ws-surface-2)] forced-colors:border-[Highlight]"
            : "border-dashed border-[var(--ws-border)] bg-[var(--ws-surface)] hover:bg-[var(--ws-hover)]",
          blocked && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
            other.open
              ? "border-[var(--ws-accent)] bg-[var(--ws-accent)] text-[color:var(--ws-on-accent)] forced-colors:border-[Highlight]"
              : "border-[var(--ws-border)]",
          )}
        >
          {other.open ? <Check className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 flex-1">{label}</span>
      </button>
      {other.open ? (
        <input
          type="text"
          {...{ [FOCUS_ATTR]: "other" }}
          aria-label={title}
          lang={lang}
          value={other.text}
          maxLength={other.max}
          placeholder={OTHER_PLACEHOLDER[question]}
          autoComplete="off"
          autoCapitalize="sentences"
          spellCheck
          enterKeyHint="done"
          onChange={(e) => onOtherText(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "mt-2 min-h-11 w-full rounded-xl border border-[var(--ws-border)] bg-[var(--ws-surface)] px-3.5 py-2 text-sm any-pointer-coarse:text-base",
            TEXT,
            RING,
          )}
        />
      ) : null}
    </div>
  );
}

function StripLine({
  strip,
  brandName,
}: {
  strip: StripView | null;
  brandName: string;
}) {
  if (!strip) return null;
  return (
    <p className={cn("mt-3 text-xs", TEXT_2)}>
      {strip.kind === "empty"
        ? COPY.stripEmpty(brandName)
        : strip.source === "profile"
          ? COPY.readyProfile
          : strip.host
            ? COPY.readyDiscovery(strip.host)
            : COPY.readyDiscoveryNoHost}
    </p>
  );
}

// "Suggestions are ready · Show": a short line inside the body, above the rows.
function ReadyBanner({ onShow }: { onShow: () => void }) {
  return (
    <div
      className={cn(
        "mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--ws-border)] px-3 py-1 text-sm",
        TEXT,
      )}
    >
      <span className="min-w-0 break-words">{COPY.bannerReady}</span>
      <Button type="button" variant="ghost" className={BTN} onClick={onShow}>
        {COPY.bannerShow}
      </Button>
    </div>
  );
}

type QuestionPanel = Extract<PanelView, { kind: "question" }>;
type ConfirmPanel = Extract<PanelView, { kind: "confirm" }>;
type CheckpointPanel = Extract<PanelView, { kind: "checkpoint" }>;
type ReviewPanel = Extract<PanelView, { kind: "review" }>;
type DonePanel = Extract<PanelView, { kind: "done" }>;

function QuestionStep({
  view,
  titleRef,
  brandName,
  languageCode,
  settingsHref,
  onPick,
  onToggleOther,
  onOtherText,
  onTier,
  onContinue,
  onShowSuggestions,
}: {
  view: QuestionPanel;
  titleRef: Ref<HTMLHeadingElement>;
  brandName: string;
  languageCode: string;
  settingsHref?: string;
  onPick: (id: string) => void;
  onToggleOther: () => void;
  onOtherText: (text: string) => void;
  onTier: () => void;
  onContinue: () => void;
  onShowSuggestions: () => void;
}) {
  const atMax = view.count !== undefined && view.count.picked >= view.count.max;
  return (
    <>
      <PausedNote inline={view.inline} settingsHref={settingsHref} />
      <Heading titleRef={titleRef} title={view.title} help={view.help} />
      {view.progress.group === "catchup" ? (
        <p className={cn("mt-2 text-xs", TEXT_2)}>{COPY.catchup}</p>
      ) : null}
      {view.current ? (
        <p className={cn("mt-2 text-xs break-words", TEXT_2)}>
          {view.current.label}{" "}
          <AiText ai={view.current.ai} lang={languageCode}>
            {view.current.text}
          </AiText>
        </p>
      ) : null}
      {view.banner === "suggestions_ready" ? (
        <ReadyBanner onShow={onShowSuggestions} />
      ) : null}
      <StripLine strip={view.strip} brandName={brandName} />
      <div
        role="group"
        aria-labelledby={GUIDED_SETUP_IDS.title}
        aria-busy={view.skeleton ? true : undefined}
        className="mt-4 space-y-2"
      >
        {view.skeleton ? (
          <SkeletonRows count={3} />
        ) : (
          view.rows.map((row) => (
            <OptionRow
              key={row.id}
              row={row}
              lang={languageCode}
              onPick={onPick}
            />
          ))
        )}
        {view.tier ? (
          <button
            type="button"
            onClick={onTier}
            className={cn(
              "flex min-h-12 w-full items-center justify-center rounded-xl border border-dashed border-[var(--ws-border)] px-3.5 py-3 text-sm font-medium hover:bg-[var(--ws-hover)]",
              TEXT,
              RING,
            )}
          >
            {view.tier.switchLabel}
          </button>
        ) : null}
        {view.other ? (
          <OtherField
            question={view.question}
            title={view.title}
            other={view.other}
            lang={languageCode}
            disabledAtMax={view.mode === "multi" && atMax}
            canContinue={view.footer.canContinue}
            onToggleOther={onToggleOther}
            onOtherText={onOtherText}
            onContinue={onContinue}
          />
        ) : null}
      </div>
      {view.count ? (
        <p className={cn("mt-2 text-xs", TEXT_2)}>
          {COPY.counter(view.count.picked, view.count.max)}
          {atMax ? ` · ${COPY.maxHint(view.count.max)}` : ""}
        </p>
      ) : null}
    </>
  );
}

function ConfirmCard({
  view,
  languageCode,
  onConfirmYes,
  onConfirmNo,
}: {
  view: ConfirmPanel;
  languageCode: string;
  onConfirmYes: () => void;
  onConfirmNo: () => void;
}) {
  return (
    <>
      <div
        className={cn(
          "mt-4 rounded-xl border border-[var(--ws-border)] bg-[var(--ws-surface)] px-4 py-3",
          TEXT,
        )}
      >
        <p className="text-sm font-medium break-words">
          <span lang={languageCode} dir="auto">
            {COPY.quote(view.candidate.text)}
          </span>
        </p>
        <div className="mt-2">
          <SuggestedTag />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          aria-pressed={view.candidate.selected}
          className={BTN}
          onClick={onConfirmYes}
        >
          {view.candidate.selected ? (
            <Check aria-hidden="true" className="size-4" />
          ) : null}
          {COPY.confirmYes}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={BTN}
          onClick={onConfirmNo}
        >
          {COPY.confirmNo}
        </Button>
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// Checkpoint, Review, Done
// -----------------------------------------------------------------------------

function Chips({ chips, lang }: { chips: ReviewChip[]; lang: string }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {chips.map((chip, i) => (
        <li
          key={`${i}-${chip.text}`}
          className={cn(
            "rounded-full border border-[var(--ws-border)] bg-[var(--ws-surface)] px-3 py-1 text-sm break-words",
            TEXT,
          )}
        >
          <AiText ai={chip.ai === true} lang={lang}>
            {chip.text}
          </AiText>
        </li>
      ))}
    </ul>
  );
}

function SuggestionsRow({
  suggestions,
  onLook,
}: {
  suggestions: { questions: string[] } | null;
  onLook: () => void;
}) {
  if (!suggestions) return null;
  return (
    <div
      className={cn(
        "mt-4 flex items-center justify-between gap-3 rounded-lg border border-[var(--ws-border)] px-3 py-1 text-sm",
        TEXT,
      )}
    >
      <span className="min-w-0 break-words">
        {COPY.suggestionsFor(suggestions.questions.join(", "))}
      </span>
      <Button type="button" variant="ghost" className={BTN} onClick={onLook}>
        {COPY.look}
      </Button>
    </div>
  );
}

function Checkpoint({
  view,
  titleRef,
  languageCode,
  onReviewNow,
  onAddDetail,
  onLook,
}: {
  view: CheckpointPanel;
  titleRef: Ref<HTMLHeadingElement>;
  languageCode: string;
  onReviewNow: () => void;
  onAddDetail: () => void;
  onLook: () => void;
}) {
  return (
    <>
      <Heading
        titleRef={titleRef}
        title={COPY.checkpointTitle}
        help={COPY.checkpointHelp}
      />
      {view.chips.length > 0 ? (
        <div className="mt-4">
          <Chips chips={view.chips} lang={languageCode} />
        </div>
      ) : null}
      <SuggestionsRow suggestions={view.suggestions} onLook={onLook} />
      <div className="mt-5 space-y-2">
        <Button
          type="button"
          className={cn(BTN, "w-full")}
          onClick={onReviewNow}
        >
          {COPY.checkpointReview}
        </Button>
        {view.detail ? (
          <Button
            type="button"
            variant="outline"
            className={cn(BTN, "w-full flex-col gap-0")}
            onClick={onAddDetail}
          >
            <span>{COPY.checkpointMore}</span>
            <span className={cn("text-xs font-normal", TEXT_2)}>
              {view.detail.count === 1
                ? COPY.checkpointMore1
                : COPY.checkpointMore2}
            </span>
          </Button>
        ) : null}
      </div>
    </>
  );
}

function ReviewValue({ row, lang }: { row: ReviewRow; lang: string }) {
  switch (row.state) {
    case "answered":
      return <Chips chips={row.chips} lang={lang} />;
    case "skipped":
      return <p className={cn("text-sm", TEXT_2)}>{COPY.skipped}</p>;
    case "delegated":
      return <p className={cn("text-sm", TEXT_2)}>{COPY.delegated}</p>;
    case "unanswered":
      return <p className={cn("text-sm", TEXT_2)}>{COPY.unanswered}</p>;
    case "current":
      return (
        <p className={cn("text-sm break-words", TEXT_2)}>
          {COPY.current("")}
          <AiText ai lang={lang}>
            {row.chips.map((c) => c.text).join(", ")}
          </AiText>
        </p>
      );
  }
}

function ReviewList({
  rows,
  brandName,
  languageCode,
  onGoTo,
}: {
  rows: ReviewRow[];
  brandName: string;
  languageCode: string;
  onGoTo: (step: StepId) => void;
}) {
  return (
    <ul className="mt-4 divide-y divide-[var(--ws-border)]">
      {rows.map((row) => (
        <li key={row.question} className="flex items-start gap-3 py-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className={cn("text-xs font-medium", TEXT_2)}>
              {REVIEW_ROW_LABEL[row.question]}
            </p>
            <ReviewValue row={row} lang={languageCode} />
          </div>
          <Button
            type="button"
            variant="ghost"
            className={cn(BTN, "min-w-11 shrink-0")}
            aria-label={COPY.editAria(questionTitleOf(row.question, brandName))}
            onClick={() => onGoTo(row.question)}
          >
            {COPY.edit}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Review({
  view,
  titleRef,
  brandName,
  languageCode,
  onGoTo,
  onLook,
}: {
  view: ReviewPanel;
  titleRef: Ref<HTMLHeadingElement>;
  brandName: string;
  languageCode: string;
  onGoTo: (step: StepId) => void;
  onLook: () => void;
}) {
  const help =
    view.help === "discovery"
      ? `${COPY.reviewHelp} ${COPY.reviewHelpDiscovery}`
      : COPY.reviewHelp;
  return (
    <>
      <Heading titleRef={titleRef} title={COPY.reviewTitle} help={help} />
      {view.banner === "saved" ? (
        <p className={cn("mt-3 text-sm font-medium", TEXT)}>
          {COPY.reviewSaved}
        </p>
      ) : null}
      {view.skippedAll ? (
        <p className={cn("mt-3 text-sm", TEXT)}>{COPY.skippedAll}</p>
      ) : null}
      <SuggestionsRow suggestions={view.suggestions} onLook={onLook} />
      <ReviewList
        rows={view.rows}
        brandName={brandName}
        languageCode={languageCode}
        onGoTo={onGoTo}
      />
      <h3 className={cn("mt-5 text-sm font-semibold", TEXT)}>
        {COPY.doesHeading}
      </h3>
      <ul className={cn("mt-2 list-disc space-y-1 pl-5 text-sm", TEXT_2)}>
        {view.lines.map((line) => (
          <li key={`${line.part}-${line.text}`} className="break-words">
            {line.text}
          </li>
        ))}
        {view.handsOn ? (
          <li className="break-words">
            {COPY.handsOn(view.handsOn.name, view.handsOn.note)}
          </li>
        ) : null}
        <li className="break-words">{COPY.never}</li>
      </ul>
    </>
  );
}

function DoneView({
  view,
  titleRef,
  draft,
  connectHref,
  onClose,
  onEditSetup,
  onDraftPlan,
}: {
  view: DonePanel;
  titleRef: Ref<HTMLHeadingElement>;
  draft?: DraftState;
  connectHref?: string;
  onClose: () => void;
  onEditSetup: () => void;
  onDraftPlan?: () => void;
}) {
  const { summary } = view;
  const phase = draft?.status ?? "idle";
  const showPlan = summary.canDraftPlan && onDraftPlan !== undefined;
  return (
    <>
      <Heading titleRef={titleRef} title={COPY.doneTitle} />
      <div className={cn("mt-3 space-y-1 text-sm", TEXT_2)}>
        {summary.goal ? (
          <p className="break-words">
            {summary.goalProposed
              ? COPY.goalProposed(summary.goal)
              : COPY.goal(summary.goal)}
          </p>
        ) : null}
        {summary.channels && summary.channels.length > 0 ? (
          <p className="break-words">
            {COPY.channels(summary.channels.join(", "))}
          </p>
        ) : null}
        {summary.saved.length > 0 ? (
          <p className="break-words">{COPY.saved(summary.saved.join(", "))}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {showPlan ? (
          <Button
            type="button"
            className={BTN}
            aria-disabled={phase !== "idle" ? true : undefined}
            onClick={phase === "idle" ? onDraftPlan : undefined}
          >
            {phase === "pending" ? COPY.planPending : COPY.plan}
          </Button>
        ) : null}
        {summary.unconnected &&
        summary.unconnected.length > 0 &&
        connectHref ? (
          <Link
            href={connectHref}
            onClick={onClose}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--ws-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--ws-hover)]",
              TEXT,
              RING,
            )}
          >
            {COPY.connect}
          </Link>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={BTN}
          onClick={onEditSetup}
        >
          {COPY.editSetup}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={BTN}
          onClick={onClose}
          {...{ [FOCUS_ATTR]: "close" }}
        >
          {COPY.close}
        </Button>
      </div>
      {showPlan && phase === "idle" && !draft?.error ? (
        <p className={cn("mt-2 text-xs", TEXT_2)}>{COPY.planHelp}</p>
      ) : null}
      {draft?.error ? (
        <p role="alert" className={cn("mt-2 text-xs", TEXT)}>
          {draft.error}
        </p>
      ) : null}
    </>
  );
}

// -----------------------------------------------------------------------------
// Footer
// -----------------------------------------------------------------------------

const FOOTER_CLASS =
  "shrink-0 border-t px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px)+var(--bleed))]";

function Footer({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div data-base-ui-swipe-ignore="" className={FOOTER_CLASS}>
      {hint}
      <div className="flex items-center justify-between gap-2">{children}</div>
    </div>
  );
}

function BackButton({
  label,
  inert,
  onBack,
}: {
  label: string;
  inert?: boolean;
  onBack: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={BTN}
      aria-disabled={inert ? true : undefined}
      onClick={inert ? undefined : onBack}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {label}
    </Button>
  );
}

function ApproveButton({
  hint,
  saving,
  applying,
  onApprove,
}: {
  hint?: "empty" | "unchanged";
  saving: boolean;
  applying: boolean;
  onApprove: () => void;
}) {
  // aria-disabled, never `disabled`: a disabled button is skipped by keyboard
  // and screen readers and cannot say why.
  const inert = applying || hint !== undefined;
  return (
    <Button
      type="button"
      className={cn(
        BTN,
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
      )}
      aria-disabled={inert ? true : undefined}
      aria-describedby={hint ? GUIDED_SETUP_IDS.approveHint : undefined}
      onClick={inert ? undefined : onApprove}
    >
      {applying || saving ? (
        <Loader2
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
      ) : (
        <Rocket aria-hidden="true" className="size-4" />
      )}
      {applying ? COPY.applying : saving ? COPY.approveSaving : COPY.approve}
    </Button>
  );
}

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

export type PanelHandlers = {
  onPick: (id: string) => void;
  onToggleOther: () => void;
  onOtherText: (text: string) => void;
  onTier: () => void;
  onContinue: () => void;
  onBack: () => void;
  onSkip: () => void;
  onGoTo: (step: StepId) => void;
  onConfirmYes: () => void;
  onConfirmNo: () => void;
  onAddDetail: () => void;
  onReviewNow: () => void;
  onShowSuggestions: () => void;
  onLook: () => void;
  onRetryIdeas: () => void;
  onApprove: () => void;
  onRetrySave: () => void;
  onReload: () => void;
  onRetryBoot: () => void;
  onClose: () => void;
  // The done view's "Edit setup" (back to Review).
  onEditSetup: () => void;
  // Only on the agent engine; without it the done view offers no plan button.
  onDraftPlan?: () => void;
};

export type DraftState = {
  status: "idle" | "pending" | "sent";
  error: string | null;
};

export type PanelContext = {
  // Forwarded to the DrawerTitle the shell focuses on every step change.
  titleRef: Ref<HTMLHeadingElement>;
  brandName: string;
  // Language of AI-derived text and of the typed field (`Project.language`).
  languageCode: string;
  // -1 animates from the left (Back).
  direction?: 1 | -1;
  // Internal links the shell knows (the panel has no project id).
  settingsHref?: string;
  connectHref?: string;
  draft?: DraftState;
};

export type GuidedSetupPanelProps = PanelView & PanelHandlers & PanelContext;

function stepKeyOf(view: PanelView): string {
  switch (view.kind) {
    case "question":
      return `q-${view.question}`;
    default:
      return view.kind;
  }
}

function ErrorState({
  titleRef,
  message,
  children,
}: {
  titleRef: Ref<HTMLHeadingElement>;
  message: string;
  children: ReactNode;
}) {
  return (
    <>
      <div role="alert">
        <Heading titleRef={titleRef} title={message} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
    </>
  );
}

// The body of a view. Every view renders the DrawerTitle (ref + tabIndex -1), so
// the shell always has a focus target and its aria ids always resolve.
function PanelBody(props: GuidedSetupPanelProps): ReactNode {
  const { titleRef, brandName, languageCode } = props;
  switch (props.kind) {
    case "boot":
      return (
        <div aria-busy="true" className="space-y-2">
          <Heading titleRef={titleRef} title={COPY.bootAria} hideTitle />
          <Skeleton
            aria-hidden="true"
            className="h-6 w-2/3 rounded-md motion-reduce:animate-none"
          />
          <SkeletonRows count={3} />
        </div>
      );
    case "bootError":
      return (
        <ErrorState titleRef={titleRef} message={COPY.errorBoot}>
          <Button type="button" className={BTN} onClick={props.onRetryBoot}>
            {COPY.tryAgain}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={BTN}
            onClick={props.onClose}
          >
            {COPY.close}
          </Button>
        </ErrorState>
      );
    case "unavailable":
      return (
        <ErrorState titleRef={titleRef} message={COPY.errorDisabled}>
          <Button
            type="button"
            variant="outline"
            className={BTN}
            onClick={props.onClose}
          >
            {COPY.close}
          </Button>
        </ErrorState>
      );
    case "expired":
      return (
        <ErrorState titleRef={titleRef} message={COPY.errorExpired}>
          <Link
            href={props.href}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--ws-accent)] px-4 py-2 text-sm font-medium text-[color:var(--ws-on-accent)]",
              RING,
            )}
          >
            {COPY.signIn}
          </Link>
        </ErrorState>
      );
    case "question":
      return (
        <QuestionStep
          view={props}
          titleRef={titleRef}
          brandName={brandName}
          languageCode={languageCode}
          settingsHref={props.settingsHref}
          onPick={props.onPick}
          onToggleOther={props.onToggleOther}
          onOtherText={props.onOtherText}
          onTier={props.onTier}
          onContinue={props.onContinue}
          onShowSuggestions={props.onShowSuggestions}
        />
      );
    case "confirm":
      return (
        <>
          <PausedNote inline={props.inline} settingsHref={props.settingsHref} />
          <Heading titleRef={titleRef} title={props.title} help={props.help} />
          {props.progress.group === "catchup" ? (
            <p className={cn("mt-2 text-xs", TEXT_2)}>{COPY.catchup}</p>
          ) : null}
          <StripLine strip={props.strip} brandName={brandName} />
          <ConfirmCard
            view={props}
            languageCode={languageCode}
            onConfirmYes={props.onConfirmYes}
            onConfirmNo={props.onConfirmNo}
          />
        </>
      );
    case "checkpoint":
      return (
        <>
          <PausedNote inline={props.inline} settingsHref={props.settingsHref} />
          <Checkpoint
            view={props}
            titleRef={titleRef}
            languageCode={languageCode}
            onReviewNow={props.onReviewNow}
            onAddDetail={props.onAddDetail}
            onLook={props.onLook}
          />
        </>
      );
    case "review":
      return (
        <>
          <PausedNote inline={props.inline} settingsHref={props.settingsHref} />
          <Review
            view={props}
            titleRef={titleRef}
            brandName={brandName}
            languageCode={languageCode}
            onGoTo={props.onGoTo}
            onLook={props.onLook}
          />
        </>
      );
    case "applying":
      return (
        <>
          <Heading titleRef={titleRef} title={COPY.applying} />
          {props.stalled ? (
            <p role="status" className={cn("mt-3 text-sm", TEXT_2)}>
              {COPY.applyingSlow}
            </p>
          ) : null}
        </>
      );
    case "done":
      return (
        <DoneView
          view={props}
          titleRef={titleRef}
          draft={props.draft}
          connectHref={props.connectHref}
          onClose={props.onClose}
          onEditSetup={props.onEditSetup}
          onDraftPlan={props.onDraftPlan}
        />
      );
  }
}

// The footer of a view (none for boot, the error states and done).
function hasFooter(kind: GuidedSetupPanelProps["kind"]): boolean {
  return (
    kind === "question" ||
    kind === "confirm" ||
    kind === "checkpoint" ||
    kind === "review" ||
    kind === "applying"
  );
}

function PanelFooter(props: GuidedSetupPanelProps): ReactNode {
  switch (props.kind) {
    case "question": {
      const { footer } = props;
      return (
        <Footer>
          {footer.canBack ? (
            <BackButton label={footer.back} onBack={props.onBack} />
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className={BTN}
              onClick={props.onSkip}
            >
              {footer.skip}
            </Button>
            <Button
              type="button"
              className={BTN}
              disabled={!footer.canContinue}
              onClick={props.onContinue}
            >
              {COPY.continue}
            </Button>
          </div>
        </Footer>
      );
    }
    case "confirm": {
      const { footer } = props;
      return (
        <Footer>
          {footer.canBack ? (
            <BackButton label={footer.back} onBack={props.onBack} />
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="ghost"
            className={BTN}
            onClick={props.onSkip}
          >
            {footer.skip}
          </Button>
        </Footer>
      );
    }
    case "checkpoint":
      return (
        <Footer>
          <BackButton label={COPY.back} onBack={props.onBack} />
        </Footer>
      );
    case "review": {
      const hint = props.approve.hint;
      return (
        <Footer
          hint={
            hint ? (
              <p
                id={GUIDED_SETUP_IDS.approveHint}
                className={cn("mb-2 text-xs", TEXT_2)}
              >
                {hint === "empty" ? COPY.hintEmpty : COPY.hintUnchanged}
              </p>
            ) : null
          }
        >
          <BackButton label={COPY.back} onBack={props.onBack} />
          <ApproveButton
            hint={hint}
            saving={props.approve.state === "saving"}
            applying={false}
            onApprove={props.onApprove}
          />
        </Footer>
      );
    }
    case "applying":
      return (
        <Footer>
          <BackButton label={COPY.back} inert onBack={props.onBack} />
          <ApproveButton saving={false} applying onApprove={props.onApprove} />
        </Footer>
      );
    default:
      return null;
  }
}

function inlineOfView(props: GuidedSetupPanelProps): InlineView | null {
  switch (props.kind) {
    case "question":
    case "confirm":
    case "checkpoint":
    case "review":
      return props.inline;
    default:
      return null;
  }
}

// Body (scrolls, swipe-ignore) + the inline alert + footer (fixed). The Drawer,
// its portal and the header belong to the shell.
export function GuidedSetupPanel(props: GuidedSetupPanelProps) {
  const direction = props.direction ?? 1;
  return (
    <>
      <DrawerBody
        className={cn(
          "px-5 pt-4",
          // The popup's bottom --bleed sits below the screen edge. A footer
          // pads past it itself; a view without one must leave that room, or
          // its last lines cannot be scrolled into sight.
          hasFooter(props.kind)
            ? "pb-4"
            : "pb-[calc(1rem+env(safe-area-inset-bottom,0px)+var(--bleed))]",
        )}
      >
        <div
          key={stepKeyOf(props)}
          className={cn(
            "animate-in fade-in duration-300 motion-reduce:animate-none",
            direction === 1 ? "slide-in-from-right-3" : "slide-in-from-left-3",
          )}
        >
          <PanelBody {...props} />
        </div>
      </DrawerBody>
      <InlineSlot inline={inlineOfView(props)} h={props} />
      <PanelFooter {...props} />
    </>
  );
}
