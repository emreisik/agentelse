"use client";

import * as React from "react";
import {
  CalendarRange,
  Film,
  Image as ImageIcon,
  Megaphone,
  Sparkles,
} from "lucide-react";
import { AgentelseMark } from "@/components/brand/agentelse-mark";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import type {
  CapabilityKey,
  CreativeContentFormat,
  SocialPlatform,
} from "@prisma/client";

import {
  submitChatMessageAction,
  type ChatMessageResult,
} from "@/server/actions/command-actions";
import { submitComposerShortcutAction } from "@/server/actions/composer-shortcut-actions";
import { createSseParser } from "@/server/chat/sse";
import type { ImageGenState } from "@/lib/image-progress";
import type { ChatStreamEvent } from "@/server/chat/types";
import { Thread } from "@/components/assistant-ui/thread";
import { ComposerPlusMenu } from "@/components/commands/composer-plus-menu";
import { ChatSendProvider } from "@/components/commands/chat-send-context";
import { WorkStart } from "@/components/works/work-start";
import {
  WorkCardHostProvider,
  type WorkCardHostInput,
} from "@/components/works/work-card-host";
import {
  appendStreamText,
  cardTextHidden,
  pendingCard,
} from "@/lib/works/card-text";
import type { WorkHost } from "@/lib/works/host";
import type { StarterAction } from "@/lib/works/starter-cards";
import {
  ChatPackageProvider,
  type PackageRunItem,
  type PackageRun,
} from "@/components/commands/chat-package-context";
import {
  failPendingItems,
  finalTaskIds,
  isLocalItemSuperseded,
  isServerRowHidden,
  localItemTaskIds,
  needsProgressPoll,
  PROGRESS_POLL_MS,
  reduceItemEvent,
} from "@/components/commands/package-run";
import { stripPlanBriefMarker } from "@/lib/plan-brief";
import { useWorkspacePanelToggle } from "@/components/workspace/workspace-panel-toggle";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import { composerAutoFocus } from "@/components/guide/composer-autofocus";
import { GuidedSetupBoundary } from "@/components/guide/guided-setup-boundary";
import {
  NextStepsBar,
  useRunNextStep,
} from "@/components/commands/next-steps-bar";
import { ManualPublishDialog } from "@/components/commands/manual-publish-dialog";
import { PlanResultsDialog } from "@/components/commands/plan-results-dialog";
import { AUTO_RUN_NEXT_KINDS, type NextStep } from "@/lib/journey";
import {
  buildGuidedSetupApi,
  GuidedSetupProvider,
  type GuidedSetupApi,
} from "@/components/guide/guided-setup-context";
import {
  ConnectedGuidedSetupChip,
  ConnectedGuidedSetupWelcomeCard,
} from "@/components/guide/guided-setup-entry";
import {
  buildDiscoveryContext,
  DiscoveryProvider,
  type DiscoveryContextValue,
} from "@/components/discovery/discovery-context";
import {
  ConnectedDiscoveryChip,
  ConnectedDiscoveryWelcomeCard,
} from "@/components/discovery/discovery-entry-view";
import type { DiscoveryHost } from "@/server/guided-discovery/host";
import {
  GUIDE_PARAM,
  type GuidedSetupHost,
  type GuidedSetupSummary,
} from "@/lib/guided-setup/contract";
import type { WorkspaceResumeStats } from "@/components/workspace/workspace-right-panel-data";
import { dayKey, dayLabel } from "@/lib/dates";
import { requestOpenAiCreditRefresh } from "@/lib/openai-credit-events";

// The sheet, its panel, reducer and the sanitizer regexes load on demand, and
// only when a host exists (the entry components above stay static and tiny).
// Nothing is prerendered: the Drawer is a client-only overlay.
const GuidedSetupSheet = dynamic(
  () =>
    import("@/components/guide/guided-setup-sheet").then(
      (mod) => mod.GuidedSetupSheet,
    ),
  { ssr: false },
);

// Same rules for the discovery sheet (the flow that replaces the wizard).
const DiscoverySheet = dynamic(
  () =>
    import("@/components/discovery/discovery-sheet").then(
      (mod) => mod.DiscoverySheet,
    ),
  { ssr: false },
);

export type ChatAttachment = {
  assetId: string;
  filename: string;
  mimeType: string;
};

// A persistent chat turn from the server (Command row). source: "SYSTEM"
// is an event message the pipeline (council, work plan, task/creative
// completion) writes to this idea's thread — there is no user message, it
// is only shown as an assistant bubble. If `card` is present (creative
// generation), it is rendered with the CreativeCard in thread.tsx instead
// of plain text.
export type ChatTurn = {
  commandId: string;
  source: "WEB" | "SYSTEM";
  text: string;
  reply: string | null;
  replyStatus: string | null;
  attachments: ChatAttachment[];
  card?: IdeaEventCardData;
  // Only set for event messages tied to a SINGLE department (task/creative
  // completion) — shown in chat as a colored side stripe matching the
  // department (see thread.tsx AssistantMessage).
  departmentKey?: DepartmentKey;
  // Only set in the single project-wide chat (see page.tsx) when this turn
  // belongs to an idea — shown as a small pill in the message header so a
  // flat, single timeline still shows which initiative each event is part
  // of (see thread.tsx AssistantMessage). Absent inside an idea's own
  // thread, where every message already belongs to that one idea.
  ideaTitle?: string;
  // Same gate as ideaTitle, but the raw id — used only to place the
  // #idea-<id> DOM anchor the "Initiatives" sidebar list jumps to (see the
  // messages useMemo below), independent of whether the title lookup
  // happened to find a display name.
  ideaId?: string;
  createdAt: string;
};

type LocalAttachment = {
  filename: string;
  mimeType: string;
  previewUrl?: string;
};

// A local turn that has been sent but not yet reflected in the server
// list. When the page is refreshed via live refresh (LiveRefresh), the
// same commandId appears in the server list and the local copy is dropped.
type LocalTurn = {
  key: string;
  text: string;
  attachments: LocalAttachment[];
  state: "pending" | "done" | "error";
  reply?: string;
  // Structured card reply (e.g. limit-notice) — shown immediately, before
  // the server list refresh delivers the persisted copy.
  card?: IdeaEventCardData;
  commandId?: string;
  // Streaming engine only: the reply as it arrives, and the label of the
  // tool currently running ("Creating task…") while the model waits on it.
  streamText?: string;
  toolLabel?: string;
  // Latest streamed preview (data URL) of the image being generated.
  previewUrl?: string;
  // Milestones of the image render in progress (drives the 0-100% bar).
  imageGen?: ImageGenState;
  // Content-package item (see startContentPackage): one assistant-only
  // message per ticked deliverable — no user bubble — driven by the item.*
  // events of the package run (package-run.ts).
  itemId?: string;
  itemTitle?: string;
  itemLabel?: string;
  // Set once the item's task exists; ties the local message to its
  // persisted chat row so the two never show at once.
  taskId?: string;
  department?: DepartmentKey;
  createdAt: string;
};

type FlatMessage =
  | {
      id: string;
      role: "user";
      text: string;
      attachments: (ChatAttachment | LocalAttachment)[];
      // DOM id for the "Initiatives" sidebar list / legacy ?entity=
      // redirect to jump to (see the messages useMemo below and
      // thread.tsx's UserMessage) — set on whichever FlatMessage is the
      // FIRST one emitted for a given idea, which can be a user bubble
      // when the idea's founding message was typed in this same chat.
      anchorId?: string;
      createdAt: string;
    }
  | {
      id: string;
      role: "assistant";
      text: string;
      card?: IdeaEventCardData;
      departmentKey?: DepartmentKey;
      ideaTitle?: string;
      // Alongside ideaTitle — lets thread.tsx's idea-title pill link to the
      // isolated per-idea thread view (?entity=idea:<id>&thread=1), not
      // just display the name.
      ideaId?: string;
      anchorId?: string;
      error?: boolean;
      // True while the reply is still arriving (streaming engine).
      streaming?: boolean;
      // The person's message behind a streaming turn (Works: picks the
      // skeleton shown before the card arrives).
      pendingRequest?: string;
      // Live preview of an image still rendering (streaming engine).
      previewUrl?: string;
      imageGen?: ImageGenState;
      // The Command row behind this message (cards with their own actions,
      // e.g. a content plan's Save button, act on it).
      commandId?: string;
      createdAt: string;
    }
  | {
      id: string;
      role: "assistant";
      // Synthetic entry, not a real Command row — marks a day boundary in
      // the single chronological timeline (see the messages useMemo below
      // and thread.tsx's ThreadMessage, which dispatches this to a plain
      // <DateDivider> instead of AssistantMessage).
      dateDivider: string;
      createdAt: string;
    };

const CHAT_ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,text/markdown";

// Package-run errors that mean nothing was started (as opposed to a run that
// broke halfway, whose items may still be working on the server).
const NOT_STARTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "PACKAGE",
  "PLAN",
  "PROJECT_INACTIVE",
  "HTTP",
  "SESSION",
]);

const STATUS_NOTE: Record<string, string> = {
  PLANNED: "Task created",
  APPROVAL_HANDLED: "Approval processed",
  UNCLEAR: "Awaiting clarification",
  ERROR: "Error",
};

// Brand Workspace composer's persistent quick-action row (docs/
// brand-workspace-migration.md §16/§17) — sent through the exact same
// path as typing them and pressing enter (no separate shortcut path).
const QUICK_ACTIONS: { label: string; icon: typeof ImageIcon }[] = [
  { label: "Create a post", icon: ImageIcon },
  { label: "Find a Reel idea", icon: Film },
  { label: "Plan the week", icon: CalendarRange },
  { label: "Create a campaign", icon: Megaphone },
];

// assistant-ui's composer immediately treats an added file as
// "sendable" — the actual upload (Asset record + Gemini payload) happens
// inside the server action, at message submission time. This adapter just
// carries the File reference through to the message.
class ProjectChatAttachmentAdapter implements AttachmentAdapter {
  accept = CHAT_ACCEPT;

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: crypto.randomUUID(),
      type: file.type.startsWith("image/") ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async remove(): Promise<void> {}

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    return { ...attachment, status: { type: "complete" }, content: [] };
  }
}

function attachmentSrc(
  attachment: ChatAttachment | LocalAttachment,
): string | undefined {
  if ("previewUrl" in attachment && attachment.previewUrl) {
    return attachment.previewUrl;
  }
  if ("assetId" in attachment) return `/api/assets/${attachment.assetId}`;
  return undefined;
}

export function ProjectChat({
  projectId,
  projectName,
  turns,
  ideaId,
  publishTargets,
  userFirstName,
  resumeStats,
  chatEngine = "legacy",
  guidedSetup,
  discovery,
  nextSteps,
  autoNext,
  workHost,
}: {
  projectId: string;
  projectName: string;
  turns: ChatTurn[];
  // When provided, this chat is an idea's thread: sent messages are
  // tagged to that idea and the LLM context is scoped to this idea's
  // history (user + pipeline events) (see ChatService.turn ideaId).
  ideaId?: string;
  // Which social platforms are actually connected for this project (see
  // getPublishTargets) — lets the "+" menu's Instagram/LinkedIn/X items
  // act as a direct "Create {Platform} post" shortcut instead of a link to
  // the integrations page (see ComposerPlusMenu).
  publishTargets: PublishTarget[];
  // Only passed on the root (non-idea) chat — the "Good morning, {name}."
  // greeting + resume card. Absent in an idea thread, where the greeting
  // doesn't apply.
  userFirstName?: string | null;
  resumeStats?: WorkspaceResumeStats;
  // "agent" streams replies from /api/projects/[id]/chat (SSE, tool calling,
  // real Stop); "legacy" uses the blocking Server Action (see CHAT_ENGINE).
  chatEngine?: "agent" | "legacy";
  // Only passed by the project page when GUIDED_SETUP is on (and loadGuidedHost
  // did not fail). Ignored in an idea thread: the sheet never mounts there.
  guidedSetup?: GuidedSetupHost;
  // Passed instead of guidedSetup when GUIDED_SETUP is on (discovery-first
  // setup). When present the old sheet never mounts. Ignored in an idea thread.
  discovery?: DiscoveryHost;
  // What to do next on the project's content plan, worked out by the server
  // from the records (journey/next-steps.ts). Empty/absent: the default
  // shortcuts show instead. Ignored in an idea thread.
  nextSteps?: NextStep[];
  // `?next=<kind>` on the URL (the calendar's banner): run that step once on
  // landing. Latched at mount, like `?guide=setup`.
  autoNext?: string;
  // Works on (docs/works.md): the Work this conversation is, with what its
  // empty screen shows. Every turn is sent with its id; the quick-action chips
  // give way to the channel chooser / next-step cards. Absent: the old chat.
  workHost?: WorkHost;
}) {
  const router = useRouter();
  // Works on: every Works-only behaviour below hangs on this one flag.
  const inWork = Boolean(workHost);
  // The sheet crashed (e.g. its lazy chunk failed to load): every entry hides
  // as with the flag off instead of greying out over a sheet that is gone.
  const [guidedBroken, setGuidedBroken] = React.useState(false);
  // The feature needs a host and the root chat.
  const guidedEnabled =
    Boolean(guidedSetup) && !discovery && !ideaId && !guidedBroken;
  const [discoveryBroken, setDiscoveryBroken] = React.useState(false);
  const discoveryEnabled = Boolean(discovery) && !ideaId && !discoveryBroken;
  // ?guide=setup was on the URL at mount. Latched: the page recomputes
  // `requested` on every server render, but only the landing may auto-open.
  const [requestedAtMount] = React.useState(
    () =>
      (guidedEnabled && Boolean(guidedSetup?.requested)) ||
      (discoveryEnabled && Boolean(discovery?.requested)),
  );
  // The composer autofocus is latched ONCE: a live value would flip on the
  // first router.refresh() and focus the composer over an open sheet (or open
  // the phone keyboard over the receipt after Approve).
  const [quietComposer] = React.useState(
    () =>
      !composerAutoFocus({
        requested: Boolean(guidedSetup?.requested ?? discovery?.requested),
        coarsePointer:
          typeof window !== "undefined" &&
          window.matchMedia("(pointer: coarse)").matches,
        hasHost: Boolean(guidedSetup ?? discovery),
      }),
  );
  const [guidedOpen, setGuidedOpen] = React.useState(
    requestedAtMount && guidedEnabled,
  );
  const [discoveryOpen, setDiscoveryOpen] = React.useState(
    requestedAtMount && discoveryEnabled,
  );
  const discoveryOpenRef = React.useRef(requestedAtMount && discoveryEnabled);
  const discoveryOpenerRef = React.useRef<HTMLElement | null>(null);

  // Mirror of guidedOpen for the idempotency check in open() (handlers only).
  const guidedOpenRef = React.useRef(requestedAtMount && guidedEnabled);
  const guidedOpenerRef = React.useRef<HTMLElement | null>(null);
  const [guidedSeed, setGuidedSeed] = React.useState<string | undefined>();
  const [guidedSummary, setGuidedSummary] =
    React.useState<GuidedSetupSummary | null>(null);
  const [localTurns, setLocalTurns] = React.useState<LocalTurn[]>([]);
  const [isActionSending, startTransition] = React.useTransition();
  // Key of the local turn whose SSE stream is open, and the controller that
  // Stop aborts. Ref for the controller (no re-render needed to abort).
  const [streamingKey, setStreamingKey] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // Follow-up prompts from the last finished reply (suggest_replies tool).
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const isSending = isActionSending || streamingKey !== null;
  // Content-package runs pressed in this session (see chat-package-context.tsx).
  const [packageRuns, setPackageRuns] = React.useState<
    Record<string, PackageRun>
  >({});
  const attachmentAdapter = React.useMemo(
    () => new ProjectChatAttachmentAdapter(),
    [],
  );

  // One open(): every entry point (URL, stream card, Welcome card, chip, "+"
  // menu, card launcher) calls it, and it is idempotent. Event handlers only.
  const openGuided = React.useCallback<GuidedSetupApi["open"]>((_source, opts) => {
    if (guidedOpenRef.current) return;
    guidedOpenRef.current = true;
    // Where focus returns when the sheet closes.
    guidedOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setGuidedSeed(opts?.seedCommandId);
    setGuidedOpen(true);
  }, []);
  const closeGuided = React.useCallback(() => {
    guidedOpenRef.current = false;
    setGuidedOpen(false);
  }, []);
  const failGuided = React.useCallback(() => {
    guidedOpenRef.current = false;
    setGuidedOpen(false);
    setGuidedBroken(true);
  }, []);
  const openDiscovery = React.useCallback<DiscoveryContextValue["open"]>(() => {
    if (discoveryOpenRef.current) return;
    discoveryOpenRef.current = true;
    discoveryOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDiscoveryOpen(true);
  }, []);
  const closeDiscovery = React.useCallback(() => {
    discoveryOpenRef.current = false;
    setDiscoveryOpen(false);
  }, []);
  const failDiscovery = React.useCallback(() => {
    discoveryOpenRef.current = false;
    setDiscoveryOpen(false);
    setDiscoveryBroken(true);
  }, []);
  const discoveryApi = React.useMemo(
    () =>
      discoveryEnabled && discovery
        ? buildDiscoveryContext({
            isOpen: discoveryOpen,
            open: openDiscovery,
            close: closeDiscovery,
            view: discovery.view,
            brandName: discovery.brandName,
          })
        : null,
    [discoveryEnabled, discovery, discoveryOpen, openDiscovery, closeDiscovery],
  );
  const liveGuidedSummary = guidedSummary ?? guidedSetup?.summary ?? null;
  const guidedApi = React.useMemo(
    () =>
      guidedEnabled && liveGuidedSummary
        ? buildGuidedSetupApi({
            isOpen: guidedOpen,
            open: openGuided,
            close: closeGuided,
            summary: liveGuidedSummary,
            canDraftPlan: chatEngine === "agent",
          })
        : null,
    [
      guidedEnabled,
      guidedOpen,
      openGuided,
      closeGuided,
      liveGuidedSummary,
      chatEngine,
    ],
  );

  // Drop ?guide=setup once it has been acted on, so a reload or a shared link
  // does not reopen the sheet. replaceState integrates with the Next router; no
  // state is set here.
  React.useEffect(() => {
    if (!requestedAtMount) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(GUIDE_PARAM)) return;
    url.searchParams.delete(GUIDE_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [requestedAtMount]);

  // Drop local copies of turns once they land in the server list.
  const serverIds = React.useMemo(
    () => new Set(turns.map((turn) => turn.commandId)),
    [turns],
  );
  // Content-package items: the live local message gives way to the persisted
  // row of its task only once that row is final (see package-run.ts).
  const finalServerTaskIds = React.useMemo(
    () => finalTaskIds(turns.map((turn) => turn.card)),
    [turns],
  );
  const visibleLocal = localTurns.filter((turn) => {
    // A settled turn gives way to its persisted row. One that is still
    // streaming stays: its row exists from the first token but only holds the
    // client's message, so dropping the turn on a mid-stream page refresh
    // would blank the reply that is being written.
    if (
      turn.state !== "pending" &&
      turn.commandId &&
      serverIds.has(turn.commandId)
    ) {
      return false;
    }
    return !isLocalItemSuperseded(turn, finalServerTaskIds);
  });

  const messages = React.useMemo<FlatMessage[]>(() => {
    const out: FlatMessage[] = [];
    // Both loops below feed the same flat, single-chat timeline (turns is
    // already chronological), so a single running "last day seen" cursor
    // spans them — a divider must appear even between the last server turn
    // and the first pending local turn if the calendar day rolled over.
    let lastDayKey: string | null = null;
    const maybeDivider = (createdAt: string) => {
      const key = dayKey(createdAt);
      if (key === lastDayKey) return;
      lastDayKey = key;
      out.push({
        id: `divider-${key}`,
        role: "assistant",
        dateDivider: dayLabel(createdAt),
        createdAt,
      });
    };
    // The "Initiatives" sidebar list (see sidebar-nav.tsx) and the legacy
    // ?entity= redirect (page.tsx) both jump to `#idea-<id>` — placed on
    // whichever FlatMessage is emitted FIRST for that idea, so only one
    // element per idea ever claims the id (duplicate DOM ids would make
    // the jump land on the wrong one).
    const seenIdeaAnchors = new Set<string>();
    const anchorFor = (ideaId?: string) => {
      if (!ideaId || seenIdeaAnchors.has(ideaId)) return undefined;
      seenIdeaAnchors.add(ideaId);
      return `idea-${ideaId}`;
    };

    // A content-package item is shown live from its local message; the
    // persisted "running" row of the same task stays hidden until it is final.
    const liveTaskIds = localItemTaskIds(visibleLocal);
    for (const turn of turns) {
      if (isServerRowHidden(turn.card, liveTaskIds)) continue;
      maybeDivider(turn.createdAt);
      if (turn.source === "SYSTEM") {
        // Pipeline event: no user bubble, just an assistant note — if
        // card data is present (creative generation), CreativeCard is
        // shown instead of plain text (see convertMessage).
        if (turn.reply) {
          out.push({
            id: `${turn.commandId}-a`,
            role: "assistant",
            text: turn.reply,
            commandId: turn.commandId,
            card: turn.card,
            departmentKey: turn.departmentKey,
            ideaTitle: turn.ideaTitle,
            ideaId: turn.ideaId,
            anchorId: anchorFor(turn.ideaId),
            createdAt: turn.createdAt,
          });
        }
        continue;
      }
      out.push({
        id: `${turn.commandId}-u`,
        role: "user",
        text: turn.text,
        attachments: turn.attachments,
        anchorId: anchorFor(turn.ideaId),
        createdAt: turn.createdAt,
      });
      if (turn.reply) {
        const note = turn.replyStatus
          ? STATUS_NOTE[turn.replyStatus]
          : undefined;
        out.push({
          id: `${turn.commandId}-a`,
          role: "assistant",
          commandId: turn.commandId,
          text: note ? `${turn.reply}\n\n*${note}*` : turn.reply,
          // A user turn can also carry a card reply (limit-notice) — when
          // present it replaces the plain text, same as SYSTEM events.
          card: turn.card,
          // Which team it went to, alongside the "Task created" note, is
          // now shown NOT as plain text but with the actual
          // DepartmentBadge (department color+icon) rendered by
          // thread.tsx from departmentKey.
          departmentKey: turn.departmentKey,
          ideaTitle: turn.ideaTitle,
          ideaId: turn.ideaId,
          createdAt: turn.createdAt,
        });
      }
    }
    for (const turn of visibleLocal) {
      maybeDivider(turn.createdAt);
      if (turn.itemId !== undefined) {
        if (turn.state === "pending") {
          const heading = turn.itemLabel
            ? `**${turn.itemLabel}** — ${turn.itemTitle ?? ""}`
            : (turn.itemTitle ?? "");
          out.push({
            id: `${turn.key}-a`,
            role: "assistant",
            text: `${heading}\n\n*${turn.imageGen ? "Generating image…" : "Writing…"}*`,
            previewUrl: turn.previewUrl,
            imageGen: turn.imageGen,
            card: turn.card,
            departmentKey: turn.department,
            createdAt: turn.createdAt,
          });
        } else if (turn.reply) {
          out.push({
            id: `${turn.key}-a`,
            role: "assistant",
            text: turn.reply,
            commandId: turn.commandId,
            card: turn.card,
            departmentKey: turn.department,
            error: turn.state === "error",
            createdAt: turn.createdAt,
          });
        }
        continue;
      }
      // The server list already shows the client's message once the turn's
      // row exists (a streaming turn's row exists from the first token).
      if (!(turn.commandId !== undefined && serverIds.has(turn.commandId))) {
        out.push({
          id: `${turn.key}-u`,
          role: "user",
          text: turn.text,
          attachments: turn.attachments,
          createdAt: turn.createdAt,
        });
      }
      if (turn.state === "pending") {
        const streamed = turn.streamText ?? "";
        // In a Work a turn with no text yet shows the skeleton card instead of
        // "Thinking…", and a card whose words replace the reply shows while
        // the turn still streams.
        const text = streamed
          ? turn.toolLabel
            ? `${streamed}\n\n*${turn.toolLabel}*`
            : streamed
          : workHost
            ? ""
            : (turn.toolLabel ?? "Thinking…");
        const showCardNow = workHost && cardTextHidden(turn.card, true);
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text,
          streaming: true,
          previewUrl: turn.previewUrl,
          imageGen: turn.imageGen,
          ...(showCardNow
            ? { card: turn.card, commandId: turn.commandId }
            : {}),
          ...(workHost ? { pendingRequest: turn.text } : {}),
          createdAt: turn.createdAt,
        });
      } else if (turn.reply) {
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text: turn.reply,
          commandId: turn.commandId,
          card: turn.card,
          error: turn.state === "error",
          createdAt: turn.createdAt,
        });
      }
    }
    return out;
  }, [turns, visibleLocal, serverIds, workHost]);

  const convertMessage = React.useCallback(
    (message: FlatMessage): ThreadMessageLike => {
      if (message.role === "user") {
        return {
          role: "user",
          content: stripPlanBriefMarker(message.text),
          createdAt: new Date(message.createdAt),
          metadata: { custom: { anchorId: message.anchorId } },
          attachments: message.attachments.map((attachment, index) => {
            const isImage = attachment.mimeType.startsWith("image/");
            const src = attachmentSrc(attachment);
            return {
              id: `${message.id}-att-${index}`,
              type: isImage ? "image" : "file",
              name: attachment.filename,
              contentType: attachment.mimeType,
              status: { type: "complete" },
              content: isImage && src ? [{ type: "image", image: src }] : [],
            };
          }),
        };
      }
      // A synthetic day-boundary marker (see the messages useMemo above) —
      // rendered by thread.tsx's ThreadMessage as a plain <DateDivider>
      // instead of AssistantMessage, before the role/isEditing dispatch.
      if ("dateDivider" in message) {
        return {
          role: "assistant",
          content: [],
          createdAt: new Date(message.createdAt),
          metadata: { custom: { dateDivider: message.dateDivider } },
        };
      }

      // If card data is present (creative generation — loading/ready/
      // failed), the CreativeCard in thread.tsx is rendered via
      // metadata.custom.card instead of plain text (see AssistantMessage);
      // content is left empty so the same info doesn't show up twice
      // (both as plain text and as a card). departmentKey and ideaTitle are
      // carried the same way regardless of whether a card is present —
      // thread.tsx renders them as a side stripe and a header pill on
      // every assistant message, plain-text or carded alike.
      return {
        role: "assistant",
        // A plan/package card is a companion to the assistant's words (why
        // this plan, what to do next), not a replacement for them.
        content: cardTextHidden(message.card, inWork) ? [] : message.text,
        createdAt: new Date(message.createdAt),
        metadata: {
          custom: {
            card: message.card,
            commandId: message.commandId,
            previewUrl: message.previewUrl,
            imageGen: message.imageGen,
            departmentKey: message.departmentKey,
            ideaTitle: message.ideaTitle,
            ideaId: message.ideaId,
            anchorId: message.anchorId,
            // Works only: the Copy / Refresh bar would copy nothing or re-send
            // the parent message as a new Command, and a skeleton card shows
            // while the turn has neither card nor text yet.
            ...(inWork
              ? {
                  cardOnly: cardTextHidden(message.card, true),
                  pendingHint: message.streaming
                    ? (pendingCard({
                        text: message.text,
                        card: message.card,
                        request: message.pendingRequest,
                      }) ?? undefined)
                    : undefined,
                }
              : {}),
          },
        },
        status: message.error
          ? { type: "incomplete", reason: "error" }
          : message.streaming
            ? { type: "running" }
            : undefined,
      };
    },
    [inWork],
  );

  // Shared skeleton for anything that turns into a new Command: push an
  // optimistic LocalTurn immediately, call the given server action, then
  // reconcile it to "done"/"error" with the real result. sendMessage
  // (composer send + onReload retry) and sendShortcut (the "+" menu's
  // shortcuts) both funnel through this — they only differ in which server
  // action they call and what the displayed request text is.
  const runTurn = React.useCallback(
    (
      displayText: string,
      attachments: LocalAttachment[],
      submit: () => Promise<ChatMessageResult>,
    ) => {
      const key = `local-${crypto.randomUUID()}`;
      setLocalTurns((current) => [
        ...current,
        {
          key,
          text: displayText,
          attachments,
          state: "pending",
          createdAt: new Date().toISOString(),
        },
      ]);

      return new Promise<void>((resolve) => {
        startTransition(async () => {
          let result: ChatMessageResult;
          try {
            result = await submit();
          } catch (error) {
            result = {
              ok: false,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to send message",
            };
          }

          setLocalTurns((current) =>
            current.map((turn) =>
              turn.key === key
                ? result.ok
                  ? {
                      ...turn,
                      state: "done",
                      reply: result.reply,
                      card: result.card,
                      commandId: result.commandId,
                    }
                  : { ...turn, state: "error", reply: result.message }
                : turn,
            ),
          );
          if (!result.ok) toast.error(result.message);
          resolve();
        });
      });
    },
    [],
  );

  // Streaming counterpart of runTurn (CHAT_ENGINE=agent): POSTs the message to
  // the SSE route and folds each ChatStreamEvent into the same optimistic
  // LocalTurn, so the reply grows token by token. Stop aborts the fetch, which
  // aborts the model stream on the server; the server keeps and persists the
  // partial reply either way.
  const runStreamingTurn = React.useCallback(
    async (text: string, files: File[]) => {
      const key = `local-${crypto.randomUUID()}`;
      const controller = new AbortController();
      abortRef.current = controller;
      setLocalTurns((current) => [
        ...current,
        {
          key,
          text: text || "(file sent)",
          attachments: files.map((file) => ({
            filename: file.name,
            mimeType: file.type,
            previewUrl: file.type.startsWith("image/")
              ? URL.createObjectURL(file)
              : undefined,
          })),
          state: "pending",
          createdAt: new Date().toISOString(),
        },
      ]);
      setStreamingKey(key);
      setSuggestions([]);

      const patch = (update: (turn: LocalTurn) => LocalTurn) =>
        setLocalTurns((current) =>
          current.map((turn) => (turn.key === key ? update(turn) : turn)),
        );

      let streamed = "";
      // The card of this turn, so text that follows a card that replaces the
      // reply can be dropped in a Work.
      let streamCard: IdeaEventCardData | undefined;
      let finished = false;
      // `done` repeats the card: open the sheet once per turn.
      let openedGuided = false;
      const apply = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "start":
            patch((turn) => ({ ...turn, commandId: event.commandId }));
            break;
          case "text.delta":
            streamed = appendStreamText(
              streamed,
              event.text,
              streamCard,
              inWork,
            );
            patch((turn) => ({ ...turn, streamText: streamed }));
            break;
          case "tool.start":
            patch((turn) => ({
              ...turn,
              toolLabel: event.label,
              imageGen:
                event.name === "generate_image"
                  ? { startedAt: Date.now(), partials: 0, done: false }
                  : turn.imageGen,
            }));
            break;
          case "tool.end":
            patch((turn) => ({
              ...turn,
              toolLabel: undefined,
              // A finished render stays on screen at 100% while the model
              // wraps up; the "done" event below clears it for the card.
              imageGen:
                event.name === "generate_image" && turn.imageGen
                  ? event.ok
                    ? { ...turn.imageGen, done: true }
                    : undefined
                  : turn.imageGen,
              previewUrl:
                event.name === "generate_image" && event.ok
                  ? turn.previewUrl
                  : undefined,
            }));
            break;
          case "image.partial":
            patch((turn) => ({
              ...turn,
              previewUrl: event.dataUrl,
              imageGen: {
                startedAt: turn.imageGen?.startedAt ?? Date.now(),
                partials: Math.max(
                  turn.imageGen?.partials ?? 0,
                  event.index + 1,
                ),
                done: false,
              },
            }));
            break;
          case "card":
            streamCard = event.card;
            patch((turn) => ({ ...turn, card: event.card }));
            if (
              guidedEnabled &&
              !openedGuided &&
              event.card.kind === "guided-setup" &&
              event.card.state === "open"
            ) {
              openedGuided = true;
              openGuided("stream", {
                seedCommandId: event.card.sourceCommandId,
              });
            }
            break;
          case "suggestions":
            setSuggestions(event.items);
            break;
          case "done":
            finished = true;
            requestOpenAiCreditRefresh();
            patch((turn) => ({
              ...turn,
              state: "done",
              reply: event.reply,
              card: event.card ?? turn.card,
              commandId: event.commandId,
              streamText: undefined,
              toolLabel: undefined,
              previewUrl: undefined,
              imageGen: undefined,
            }));
            break;
          case "error":
            finished = true;
            patch((turn) => ({
              ...turn,
              state: "error",
              // Keep whatever the client already read if the stream died
              // halfway; the error itself is surfaced as a toast.
              reply: streamed || event.message,
              card: event.card ?? turn.card,
              streamText: undefined,
              toolLabel: undefined,
              previewUrl: undefined,
              imageGen: undefined,
            }));
            if (!event.card) toast.error(event.message);
            break;
        }
      };

      try {
        const formData = new FormData();
        formData.set("text", text);
        if (ideaId) formData.set("ideaId", ideaId);
        if (workHost) formData.set("workId", workHost.work.id);
        for (const file of files) formData.append("files", file);

        const response = await fetch(`/api/projects/${projectId}/chat`, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !response.body) {
          let message = "Failed to send message";
          try {
            const data = (await response.json()) as { error?: string };
            if (data.error) message = data.error;
          } catch {
            // Non-JSON error body: keep the generic message.
          }
          apply({ type: "error", code: "HTTP", message });
          return;
        }
        if (!contentType.includes("text/event-stream")) {
          // A signed-out session is redirected to the login page (HTML).
          apply({
            type: "error",
            code: "SESSION",
            message: "Your session has expired. Please sign in again.",
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parse = createSseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parse(decoder.decode(value, { stream: true }))) {
            apply(event);
          }
        }
        if (!finished) {
          apply({
            type: "error",
            code: "CLOSED",
            message: "The connection closed before the reply finished.",
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          patch((turn) => ({
            ...turn,
            state: "done",
            reply: streamed || "(stopped)",
            streamText: undefined,
            toolLabel: undefined,
            previewUrl: undefined,
            imageGen: undefined,
          }));
        } else {
          apply({
            type: "error",
            code: "NETWORK",
            message:
              error instanceof Error ? error.message : "Failed to send message",
          });
        }
      } finally {
        abortRef.current = null;
        setStreamingKey(null);
        // Pulls the persisted Command rows; the local copy drops itself once
        // its commandId shows up in the server list.
        router.refresh();
      }
    },
    [projectId, ideaId, router, guidedEnabled, openGuided, workHost, inWork],
  );

  const sendMessage = React.useCallback(
    (text: string, files: File[]) => {
      if (!text && files.length === 0) return Promise.resolve();
      if (workHost && workHost.work.status !== "ACTIVE") {
        toast.info("Reopen this Work to continue.");
        return Promise.resolve();
      }
      if (chatEngine === "agent") return runStreamingTurn(text, files);

      return runTurn(
        text || "(file sent)",
        files.map((file) => ({
          filename: file.name,
          mimeType: file.type,
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
        })),
        () => {
          const formData = new FormData();
          formData.set("projectId", projectId);
          if (ideaId) formData.set("ideaId", ideaId);
          formData.set("text", text);
          for (const file of files) formData.append("files", file);
          return submitChatMessageAction(formData);
        },
      );
    },
    [runTurn, runStreamingTurn, chatEngine, projectId, ideaId, workHost],
  );

  // The composer's "+" menu shortcuts (see ComposerPlusMenu /
  // composer-shortcuts.ts) — bypasses the LLM entirely with a precomputed
  // CAPABILITY intent (see composer-shortcut.ts) instead of pre-filling
  // text for the composer to classify.
  const sendShortcut = React.useCallback(
    (
      capability: CapabilityKey,
      request: string,
      targetPlatform?: SocialPlatform,
      contentFormat?: CreativeContentFormat,
    ) => {
      // "Create a content plan" under the agent engine goes through the chat,
      // not the shortcut bypass: the agent opens the plan-brief wizard (goal,
      // channels, rhythm) and drafts a plan the client saves to the calendar.
      // The bypass would run the old weekly planner inside the request and
      // start generating images straight from a menu click.
      // In a Work every shortcut is a chat message too: it hits the channel
      // gate and the Work's rules instead of creating standalone work.
      if (
        (chatEngine === "agent" && capability === "CREATE_CONTENT_PLAN") ||
        inWork
      ) {
        return sendMessage(request, []);
      }
      return runTurn(request, [], () =>
        submitComposerShortcutAction(
          projectId,
          capability,
          request,
          targetPlatform,
          ideaId,
          contentFormat,
        ),
      );
    },
    [runTurn, sendMessage, chatEngine, projectId, ideaId, inWork],
  );

  const onNew = React.useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const files = (message.attachments ?? [])
        .map((attachment) => attachment.file)
        .filter((file): file is File => Boolean(file));
      await sendMessage(text, files);
    },
    [sendMessage],
  );

  // "Refresh"/retry on an assistant bubble (thread.tsx's AssistantActionBar)
  // calls this unconditionally whenever the message isn't running — without
  // it, assistant-ui throws "Runtime does not support reloading messages."
  // `parentId` is the stringified index of the preceding message in `messages`
  // (assistant-ui falls back to array index when convertMessage doesn't set
  // an id — see fromThreadMessageLike). Stored attachments are fetched back
  // from the asset store so the retry carries the same files, not just text.
  const onReload = React.useCallback(
    async (parentId: string | null) => {
      const parent = parentId !== null ? messages[Number(parentId)] : undefined;
      if (!parent || parent.role !== "user") {
        toast.error("Can't retry this message.");
        return;
      }
      const files: File[] = [];
      for (const attachment of parent.attachments) {
        if (!("assetId" in attachment)) continue;
        try {
          const response = await fetch(`/api/assets/${attachment.assetId}`);
          if (!response.ok) throw new Error(String(response.status));
          files.push(
            new File([await response.blob()], attachment.filename, {
              type: attachment.mimeType,
            }),
          );
        } catch {
          toast.error(`Couldn't re-attach ${attachment.filename}.`);
        }
      }
      await sendMessage(parent.text, files);
    },
    [messages, sendMessage],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: isSending,
    suggestions: suggestions.map((prompt) => ({ prompt })),
    onNew,
    onReload,
    // Stop: aborts the SSE fetch, which aborts the model stream server-side.
    // A no-op on the legacy blocking path (nothing to abort).
    onCancel: async () => {
      abortRef.current?.abort();
    },
    adapters: { attachments: attachmentAdapter },
  });

  // Deep-link jump for the "Initiatives" sidebar list (see sidebar-nav.tsx)
  // and the legacy ?entity= redirect (page.tsx) — both land here with a
  // `#idea-<id>` fragment, matching the anchorId placed in the messages
  // useMemo above. assistant-ui's own scrollToBottomOnInitialize already
  // runs on mount; this runs one tick later (and again on hashchange,
  // since clicking a different sidebar entry while already on this page
  // doesn't remount it) to override that default and land on the
  // requested idea instead of the latest message. Best-effort:
  // fragment-navigation into a nested scrollable container isn't
  // guaranteed cross-browser, hence a manual scrollIntoView instead of
  // relying on the native anchor behavior.
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scrollToHash = () => {
      const hash = window.location.hash;
      if (hash.length < 2) return;
      const id = hash.slice(1);
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ block: "center" });
      }, 80);
    };
    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", scrollToHash);
    };
  }, []);

  // Time-of-day greeting — same SSR-safe useSyncExternalStore shape as
  // workspace-panel-toggle.tsx: the server (and the client's first paint,
  // which must match it) always sees "Welcome back", then React re-syncs to
  // the visitor's real local time right after — no hydration mismatch, no
  // setState-in-effect.
  const timeGreeting = React.useSyncExternalStore(
    () => () => {},
    () => {
      const hour = new Date().getHours();
      return hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
    },
    () => "Welcome back",
  );

  const { openTab } = useWorkspacePanelToggle();

  const hasResumeStats =
    resumeStats &&
    (resumeStats.drafts > 0 ||
      resumeStats.pendingApproval > 0 ||
      resumeStats.approved > 0);

  // A starter card's button: send a message, open a page, or open a right-panel
  // tab. A card never does anything a typed message or a link could not.
  const actOnStarter = React.useCallback(
    (action: StarterAction) => {
      if (action.kind === "send") void sendMessage(action.text, []);
      else if (action.kind === "link") router.push(action.href);
      else openTab(action.tab);
    },
    [sendMessage, router, openTab],
  );

  const Welcome = React.useCallback(
    () =>
      ideaId ? (
        <div className="mb-6 flex flex-col items-center gap-3 px-4 text-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
            <Sparkles className="size-4" />
          </span>
          <p className="max-w-sm text-sm text-muted-foreground">
            Hi! I&apos;m here for {projectName}. Ask for content, ask a
            question, or give instructions by attaching an image/file — for
            example &quot;prepare an Instagram post using this image&quot;.
          </p>
        </div>
      ) : (
        <div className="mb-9 px-1">
          <div className="relative">
            <h1
              className="max-w-[calc(100%-80px)] text-[29px] leading-[1.15] font-medium sm:text-[35px]"
              style={{ color: "var(--ws-text)", letterSpacing: "-1.4px" }}
            >
              {userFirstName
                ? `${timeGreeting}, ${userFirstName}`
                : "Your brand workspace"}
              <span style={{ color: "var(--ws-olive)" }}>.</span>
            </h1>
            <AgentelseMark
              aria-hidden
              className="pointer-events-none absolute top-0 right-0 hidden size-14 rotate-12 sm:block"
              style={{ color: "var(--ws-olive)", opacity: 0.5 }}
            />
          </div>
          <p
            className="mt-3 max-w-lg text-sm leading-6"
            style={{ color: "var(--ws-text-2)" }}
          >
            What should we bring to life for your brand today?
          </p>

          {hasResumeStats ? (
            <div
              className="mt-5 rounded-[13px] border px-4 py-3.5 sm:px-[18px]"
              style={{
                borderColor: "var(--ws-border)",
                background: "var(--ws-surface-2)",
              }}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div>
                  <div
                    className="text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    Where we left off.
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {projectName}
                  </div>
                </div>
                <div className="grid grid-cols-3 items-center gap-2 sm:ml-auto sm:flex sm:gap-0">
                  <ResumeStat
                    value={resumeStats!.drafts}
                    label="ready drafts"
                    onClick={() => openTab("outputs")}
                    divider={false}
                  />
                  <ResumeStat
                    value={resumeStats!.pendingApproval}
                    label="pending approval"
                    onClick={() => openTab("outputs")}
                  />
                  <ResumeStat
                    value={resumeStats!.approved}
                    label="approved"
                    onClick={() => openTab("calendar")}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {workHost ? (
            <WorkStart
              projectId={projectId}
              host={workHost}
              disabled={isSending || workHost.work.status !== "ACTIVE"}
              onAct={actOnStarter}
              onChannelsSaved={() => router.refresh()}
            />
          ) : null}

          {/* Flag off: no wrapper at all (the markup stays as before).
              empty:hidden keeps the gap away when the card renders nothing. */}
          {guidedEnabled ? (
            <div className="mt-5 empty:hidden">
              <ConnectedGuidedSetupWelcomeCard projectName={projectName} />
            </div>
          ) : null}
          {discoveryEnabled ? (
            <div className="mt-5 empty:hidden">
              <ConnectedDiscoveryWelcomeCard />
            </div>
          ) : null}
        </div>
      ),
    [
      ideaId,
      guidedEnabled,
      discoveryEnabled,
      projectName,
      projectId,
      userFirstName,
      timeGreeting,
      hasResumeStats,
      resumeStats,
      openTab,
      workHost,
      isSending,
      actOnStarter,
      router,
    ],
  );

  const PlusMenu = React.useCallback(
    () => (
      <ComposerPlusMenu
        projectId={projectId}
        publishTargets={publishTargets}
        disabled={isSending}
        onShortcut={sendShortcut}
        works={inWork}
      />
    ),
    [projectId, publishTargets, isSending, sendShortcut, inWork],
  );

  // Replaces the composer's old inert "Automatic" label with something
  // real: BrandTwin context genuinely is loaded into every chat turn (see
  // chat-service.ts's buildContext, Phase 5) — this just makes that
  // already-true fact visible instead of a fake mode toggle. Spec: "thin
  // divider, selected brand context, small status dot, context on" — the
  // divider is rendered here (rather than by the composer shell) since
  // ComposerPlusMenu is optional and this is the only slot that knows
  // whether it's present.
  const ContextChip = React.useCallback(
    () => (
      <span className="flex items-center gap-1.5 text-[11px] select-none">
        <span
          className="h-4 w-px shrink-0"
          style={{ background: "var(--ws-border)" }}
        />
        <span
          className="size-1.5 rounded-full"
          style={{ background: "var(--ws-approved)" }}
        />
        <span style={{ color: "var(--ws-text-3)" }}>
          {projectName} context on
        </span>
      </span>
    ),
    [projectName],
  );

  // A live production run pressed on a card: every piece shows up as its own
  // assistant message and is produced live — images sharpen in place, text
  // shows a running card — from the tagged item.* events of the run's route.
  // Independent of the chat turn stream (the composer stays usable), so several
  // items run side by side. A content package knows its pieces up front (the
  // ticked items); a content plan lets the server pick them (the nearest week)
  // and announces them first with run.items.
  const runProduction = React.useCallback(
    async ({
      commandId,
      endpoint,
      body,
      items: knownItems,
      noun,
    }: {
      commandId: string;
      endpoint: string;
      body: unknown;
      items?: PackageRunItem[];
      noun: "package" | "plan";
    }): Promise<{ ok: boolean }> => {
      const runKey = `${noun === "plan" ? "plan" : "pkg"}-${commandId}`;
      const inRun = (turn: LocalTurn) =>
        turn.itemId !== undefined && turn.key.startsWith(`${runKey}:`);
      const notStarted = `Could not start the ${noun === "plan" ? "production" : "package"}.`;
      let itemIds: string[] = [];
      const startedAt = Date.now();
      const openItems = (items: PackageRunItem[]) => {
        const createdAt = new Date().toISOString();
        itemIds = items.map((item) => item.id);
        setPackageRuns((current) => ({
          ...current,
          [commandId]: { phase: "running", itemIds },
        }));
        setLocalTurns((current) => [
          // A retry after a refused run replaces that run's earlier messages.
          ...current.filter((turn) => !inRun(turn)),
          ...items.map((item): LocalTurn => ({
            key: `${runKey}:${item.id}`,
            text: item.title,
            attachments: [],
            state: "pending",
            createdAt,
            itemId: item.id,
            itemTitle: item.title,
            itemLabel: item.label,
            department: item.department,
            imageGen: item.image
              ? { startedAt, partials: 0, done: false }
              : undefined,
          })),
        ]);
      };
      openItems(knownItems ?? []);

      let started = 0;
      let finished = false;
      // Any item event means the run was claimed and is running on the
      // server, even if the connection later drops before package.done.
      let claimed = false;
      // Works: the header's "working" line comes from the server, so pull the
      // page once when the run is claimed.
      let refreshedForWork = false;
      const settle = (message: string) =>
        setLocalTurns((current) => failPendingItems(current, inRun, message));
      // The run never started (claim refused, request rejected): its
      // placeholder messages have nothing to report, the toast says why.
      const withdraw = () =>
        setLocalTurns((current) => current.filter((turn) => !inRun(turn)));
      const apply = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "run.items":
            claimed = true;
            if (inWork && !refreshedForWork) {
              refreshedForWork = true;
              router.refresh();
            }
            openItems(
              event.items.map((item) => ({
                id: item.id,
                title: item.title,
                label: item.label,
                department: item.department as DepartmentKey | undefined,
                image: item.image,
              })),
            );
            break;
          case "item.start":
          case "item.partial":
          case "item.done":
            claimed = true;
            if (event.type === "item.done") requestOpenAiCreditRefresh();
            setLocalTurns((current) =>
              current.map((turn) =>
                inRun(turn) ? reduceItemEvent(turn, event) : turn,
              ),
            );
            break;
          case "package.done":
            finished = true;
            requestOpenAiCreditRefresh();
            started = event.started;
            // Every item that ran has reported by now; one still waiting was
            // skipped when the run was claimed.
            settle("This one was not started.");
            if (event.started === 0) {
              toast.error(`${notStarted} Try again.`);
            } else if (event.failed > 0) {
              toast.error(
                `${event.failed} of ${itemIds.length} could not be made.`,
              );
            }
            break;
          case "error":
            finished = true;
            if (NOT_STARTED_ERROR_CODES.has(event.code)) withdraw();
            else settle(event.message);
            toast.error(event.message);
            break;
        }
      };

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !response.body) {
          let message = notStarted;
          try {
            const data = (await response.json()) as { error?: string };
            if (data.error) message = data.error;
          } catch {
            // Non-JSON error body: keep the generic message.
          }
          apply({ type: "error", code: "HTTP", message });
        } else if (!contentType.includes("text/event-stream")) {
          // A signed-out session is redirected to the login page (HTML).
          apply({
            type: "error",
            code: "SESSION",
            message: "Your session has expired. Please sign in again.",
          });
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const parse = createSseParser();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const event of parse(
              decoder.decode(value, { stream: true }),
            )) {
              apply(event);
            }
          }
          if (!finished) {
            // The run keeps going on the server; its cards land in the chat
            // with the refresh below.
            settle(
              "The connection dropped — this keeps running in the background.",
            );
          }
        }
      } catch (error) {
        settle(error instanceof Error ? error.message : notStarted);
      } finally {
        setPackageRuns((current) => {
          const next = { ...current };
          // A refused run (nothing started) reopens the card for another try.
          if (started > 0 || claimed) {
            next[commandId] = { phase: "started", itemIds };
          } else delete next[commandId];
          return next;
        });
        // Pulls the persisted chat rows; each local item message drops
        // itself once its own row arrives.
        router.refresh();
      }
      return { ok: started > 0 || claimed };
    },
    [router, inWork],
  );

  // "Create selected" on a content-package card.
  const startContentPackage = React.useCallback(
    ({
      commandId,
      items,
    }: {
      commandId: string;
      items: PackageRunItem[];
    }) =>
      runProduction({
        commandId,
        endpoint: `/api/projects/${projectId}/chat/package`,
        body: {
          commandId,
          selections: items.map((item) => ({
            id: item.id,
            contentFormat: item.contentFormat,
          })),
        },
        items,
        noun: "package",
      }),
    [projectId, runProduction],
  );

  // "Save & produce" / "Produce" on a saved content-plan card, and the "next
  // step" bar: the nearest week of the plan's empty slots.
  const startContentPlan = React.useCallback(
    ({ commandId }: { commandId: string }) =>
      runProduction({
        commandId,
        endpoint: `/api/projects/${projectId}/chat/plan`,
        body: { commandId },
        noun: "plan",
      }),
    [projectId, runProduction],
  );

  const {
    run: runNextStep,
    pending: nextStepPending,
    manual: manualPublish,
    closeManual,
    results: showResults,
    closeResults,
  } = useRunNextStep({
    projectId,
    onProducePlan: (planId) => void startContentPlan({ commandId: planId }),
    onSend: (text) => void sendMessage(text, []),
  });
  // A `?next=` landing runs its step once, then drops the parameter so a
  // refresh does not run it again.
  const autoNextDone = React.useRef(false);
  React.useEffect(() => {
    if (autoNextDone.current || !autoNext) return;
    autoNextDone.current = true;
    // Inside a Work the parameter drop keeps `?work=`: the bare URL would open
    // the most recently active Work, which may not be this one.
    router.replace(
      workHost
        ? `/projects/${projectId}?work=${encodeURIComponent(workHost.work.id)}`
        : `/projects/${projectId}`,
      { scroll: false },
    );
    const kind = AUTO_RUN_NEXT_KINDS.find((candidate) => candidate === autoNext);
    const step = nextSteps?.find((candidate) => candidate.action.kind === kind);
    if (step) runNextStep(step);
  }, [autoNext, nextSteps, projectId, router, runNextStep, workHost]);
  const hasRunningRun = Object.values(packageRuns).some(
    (run) => run.phase === "running",
  );
  const QuickActions = React.useCallback(
    () =>
      ideaId ? null : (
        <>
          <ConnectedGuidedSetupChip projectId={projectId} />
          <ConnectedDiscoveryChip projectId={projectId} />
          {nextSteps && nextSteps.length > 0 ? (
            <NextStepsBar
              steps={nextSteps}
              projectId={projectId}
              disabled={isSending || hasRunningRun || nextStepPending}
              onAct={runNextStep}
            />
          ) : null}
          {manualPublish ? (
            <ManualPublishDialog
              projectId={projectId}
              creativeIds={manualPublish}
              onClose={closeManual}
            />
          ) : null}
          {showResults ? (
            <PlanResultsDialog
              projectId={projectId}
              onClose={closeResults}
              onPlanNext={() => void sendMessage("Plan the next two weeks.", [])}
            />
          ) : null}
          {/* In a Work the starter cards replace these chips. */}
          {workHost ? null : (
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-1 pb-1">
            {QUICK_ACTIONS.map(({ label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                disabled={isSending}
                onClick={() => sendMessage(label, [])}
                className="flex shrink-0 items-center gap-1.5 rounded-[7px] border px-3 py-1.5 text-[11px] font-medium whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-50 sm:text-xs"
                style={{
                  borderColor: "var(--ws-border)",
                  background: "var(--ws-surface)",
                  color: "var(--ws-text-2)",
                }}
              >
                <Icon className="size-3.5" style={{ color: "var(--ws-olive)" }} />
                {label}
              </button>
            ))}
          </div>
          )}
        </>
      ),
    [
      ideaId,
      projectId,
      workHost,
      isSending,
      sendMessage,
      nextSteps,
      hasRunningRun,
      runNextStep,
      nextStepPending,
      manualPublish,
      closeManual,
      showResults,
      closeResults,
    ],
  );

  const chatPackage = React.useMemo(
    () => ({
      start: startContentPackage,
      startPlan: startContentPlan,
      runs: packageRuns,
    }),
    [startContentPackage, startContentPlan, packageRuns],
  );

  // What the Works cards read (null outside a Work: they keep today's
  // behaviour). `busy` is a chat turn streaming only: production runs block
  // just the plan they run, through `producing`.
  const producingKey = producingPlanIds(packageRuns).join("|");
  const producing = React.useMemo<ReadonlySet<string>>(
    () => new Set(producingKey ? producingKey.split("|") : []),
    [producingKey],
  );
  // useRunNextStep returns a fresh function every render; the cards get a
  // stable one so the host value does not change on every render.
  const runNextStepRef = React.useRef(runNextStep);
  React.useEffect(() => {
    runNextStepRef.current = runNextStep;
  });
  const runNextStepStable = React.useCallback(
    (step: NextStep) => runNextStepRef.current(step),
    [],
  );
  const workHostValue = React.useMemo(
    () =>
      workHost
        ? buildWorkHostValue({
            projectId,
            workHost,
            isSending,
            producing,
            openTab,
            runNextStep: runNextStepStable,
          })
        : null,
    [workHost, projectId, isSending, producing, openTab, runNextStepStable],
  );

  // A content-package piece whose live stream is gone (page reload, dropped
  // connection) is still being made on the server. Keep pulling the page while
  // the persisted chat shows work in flight (needsProgressPoll) and nothing
  // live is driving it — neither a package run nor a streaming chat turn.
  const hasLiveItemRun = localTurns.some(
    (turn) => turn.itemId !== undefined && turn.state === "pending",
  );
  const isStreaming = streamingKey !== null;
  React.useEffect(() => {
    if (hasLiveItemRun || isStreaming) return undefined;
    if (!needsProgressPoll(turns, Date.now())) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [turns, hasLiveItemRun, isStreaming, router]);

  const sendFromCard = React.useCallback(
    (text: string) => sendMessage(text, []),
    [sendMessage],
  );

  const packageTree = (
        <ChatPackageProvider value={chatPackage}>
          <GuidedSetupProvider value={guidedApi}>
            <DiscoveryProvider value={discoveryApi}>
            <Thread
              autoFocusComposer={!quietComposer}
              components={{
                Welcome,
                ComposerPlusMenu: PlusMenu,
                QuickActions,
                ContextChip,
              }}
            />
            {guidedEnabled && guidedSetup ? (
              <GuidedSetupBoundary onError={failGuided}>
                <GuidedSetupSheet
                  projectId={projectId}
                  brandName={projectName}
                  languageCode={guidedSetup.languageCode}
                  chatEngine={chatEngine}
                  host={guidedSetup}
                  seedCommandId={guidedSeed}
                  openerRef={guidedOpenerRef}
                  onSummary={setGuidedSummary}
                />
              </GuidedSetupBoundary>
            ) : null}
            {discoveryEnabled && discovery ? (
              <GuidedSetupBoundary onError={failDiscovery}>
                <DiscoverySheet
                  projectId={projectId}
                  open={discoveryOpen}
                  onOpenChange={(next) => {
                    if (!next) closeDiscovery();
                  }}
                  initialView={discovery.view}
                  brandName={discovery.brandName}
                  openerRef={discoveryOpenerRef}
                />
              </GuidedSetupBoundary>
            ) : null}
            </DiscoveryProvider>
          </GuidedSetupProvider>
        </ChatPackageProvider>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatSendProvider value={sendFromCard}>
        {workHostValue ? (
          <WorkCardHostProvider value={workHostValue}>
            {packageTree}
          </WorkCardHostProvider>
        ) : (
          packageTree
        )}
      </ChatSendProvider>
    </AssistantRuntimeProvider>
  );
}

// The plan Command ids with a running production, sorted so the host value
// only changes when the set does.
export function producingPlanIds(
  runs: Record<string, { phase: string }>,
): string[] {
  return Object.entries(runs)
    .filter(([, run]) => run.phase === "running")
    .map(([id]) => id)
    .sort();
}

// What the Works cards read. `busy` is a chat turn streaming only: a running
// production blocks just its own plan, through `producing`.
export function buildWorkHostValue(input: {
  projectId: string;
  workHost: WorkHost;
  isSending: boolean;
  producing: ReadonlySet<string>;
  openTab: WorkCardHostInput["openTab"];
  runNextStep: WorkCardHostInput["runNextStep"];
}): WorkCardHostInput {
  const { workHost } = input;
  return {
    projectId: input.projectId,
    workId: workHost.work.id,
    workTitle: workHost.work.title,
    active: workHost.work.status === "ACTIVE",
    busy: input.isSending,
    producing: input.producing,
    timezone: workHost.timezone,
    channels: workHost.channelOptions
      .filter((option) => workHost.work.channels.includes(option.key))
      .map(({ key, label, connected }) => ({ key, label, connected })),
    connectedChannels: workHost.channelOptions
      .filter((option) => option.connected)
      .map((option) => option.key),
    openTab: input.openTab,
    runNextStep: input.runNextStep,
  };
}

function ResumeStat({
  value,
  label,
  onClick,
  divider = true,
}: {
  value: number;
  label: string;
  onClick: () => void;
  divider?: boolean;
}) {
  return (
    <div className="flex items-center">
      {divider ? (
        <span
          className="mr-4 hidden h-8 w-px shrink-0 sm:block"
          style={{ background: "var(--ws-border)" }}
        />
      ) : null}
      <button
        type="button"
        onClick={onClick}
        className="rounded-lg text-center transition-opacity hover:opacity-70"
      >
        <div
          className="text-lg font-semibold tabular-nums"
          style={{ color: "var(--ws-text)" }}
        >
          {String(value).padStart(2, "0")}
        </div>
        <div
          className="text-[10px] whitespace-nowrap"
          style={{ color: "var(--ws-text-3)" }}
        >
          {label}
        </div>
      </button>
    </div>
  );
}
