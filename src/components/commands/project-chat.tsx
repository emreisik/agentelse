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
import type { WorkspaceResumeStats } from "@/components/workspace/workspace-right-panel-data";
import { dayKey, dayLabel } from "@/lib/dates";

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
  "SETUP_REQUIRED",
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
}) {
  const router = useRouter();
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
        const text = streamed
          ? turn.toolLabel
            ? `${streamed}\n\n*${turn.toolLabel}*`
            : streamed
          : (turn.toolLabel ?? "Thinking…");
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text,
          streaming: true,
          previewUrl: turn.previewUrl,
          imageGen: turn.imageGen,
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
  }, [turns, visibleLocal, serverIds]);

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
        content:
          message.card &&
          message.card.kind !== "content-plan-draft" &&
          message.card.kind !== "plan-brief" &&
          message.card.kind !== "content-package"
            ? []
            : message.text,
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
          },
        },
        status: message.error
          ? { type: "incomplete", reason: "error" }
          : message.streaming
            ? { type: "running" }
            : undefined,
      };
    },
    [],
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
      let finished = false;
      const apply = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "start":
            patch((turn) => ({ ...turn, commandId: event.commandId }));
            break;
          case "text.delta":
            streamed += event.text;
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
                partials: Math.max(turn.imageGen?.partials ?? 0, event.index + 1),
                done: false,
              },
            }));
            break;
          case "card":
            patch((turn) => ({ ...turn, card: event.card }));
            break;
          case "suggestions":
            setSuggestions(event.items);
            break;
          case "done":
            finished = true;
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
    [projectId, ideaId, router],
  );

  const sendMessage = React.useCallback(
    (text: string, files: File[]) => {
      if (!text && files.length === 0) return Promise.resolve();
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
    [runTurn, runStreamingTurn, chatEngine, projectId, ideaId],
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
    [runTurn, projectId, ideaId],
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
        </div>
      ),
    [
      ideaId,
      projectName,
      userFirstName,
      timeGreeting,
      hasResumeStats,
      resumeStats,
      openTab,
    ],
  );

  const PlusMenu = React.useCallback(
    () => (
      <ComposerPlusMenu
        projectId={projectId}
        publishTargets={publishTargets}
        disabled={isSending}
        onShortcut={sendShortcut}
      />
    ),
    [projectId, publishTargets, isSending, sendShortcut],
  );

  const QuickActions = React.useCallback(
    () =>
      ideaId ? null : (
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
      ),
    [ideaId, isSending, sendMessage],
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

  // "Create selected" on a content-package card: every ticked deliverable
  // shows up as its own assistant message at once and is produced live —
  // images sharpen in place, text shows a running card — from the tagged
  // item.* events of the package route. Independent of the chat turn stream
  // (the composer stays usable), so several items run side by side.
  const startContentPackage = React.useCallback(
    async ({
      commandId,
      items,
    }: {
      commandId: string;
      items: PackageRunItem[];
    }): Promise<{ ok: boolean }> => {
      const runKey = `pkg-${commandId}`;
      const inRun = (turn: LocalTurn) =>
        turn.itemId !== undefined && turn.key.startsWith(`${runKey}:`);
      const createdAt = new Date().toISOString();
      const itemIds = items.map((item) => item.id);
      setPackageRuns((current) => ({
        ...current,
        [commandId]: { phase: "running", itemIds },
      }));
      const startedAt = Date.now();
      setLocalTurns((current) => [
        // A retry after a refused run replaces that run's earlier messages.
        ...current.filter((turn) => !inRun(turn)),
        ...items.map(
          (item): LocalTurn => ({
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
          }),
        ),
      ]);

      let started = 0;
      let finished = false;
      // Any item event means the package was claimed and is running on the
      // server, even if the connection later drops before package.done.
      let claimed = false;
      const settle = (message: string) =>
        setLocalTurns((current) => failPendingItems(current, inRun, message));
      // The run never started (claim refused, request rejected): its
      // placeholder messages have nothing to report, the toast says why.
      const withdraw = () =>
        setLocalTurns((current) => current.filter((turn) => !inRun(turn)));
      const apply = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "item.start":
          case "item.partial":
          case "item.done":
            claimed = true;
            setLocalTurns((current) =>
              current.map((turn) =>
                inRun(turn) ? reduceItemEvent(turn, event) : turn,
              ),
            );
            break;
          case "package.done":
            finished = true;
            started = event.started;
            // Every item that ran has reported by now; one still waiting was
            // skipped when the package was claimed.
            settle("This one was not started.");
            if (event.started === 0) {
              toast.error("Could not start the package. Try again.");
            } else if (event.failed > 0) {
              toast.error(
                `${event.failed} of ${items.length} could not be made.`,
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
        const response = await fetch(
          `/api/projects/${projectId}/chat/package`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId,
              selections: items.map((item) => ({
                id: item.id,
                contentFormat: item.contentFormat,
              })),
            }),
          },
        );
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !response.body) {
          let message = "Could not start the package.";
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
            for (const event of parse(decoder.decode(value, { stream: true }))) {
              apply(event);
            }
          }
          if (!finished) {
            // The run keeps going on the server; its cards land in the chat
            // with the refresh below.
            settle("The connection dropped — this keeps running in the background.");
          }
        }
      } catch (error) {
        settle(
          error instanceof Error ? error.message : "Could not start the package.",
        );
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
    [projectId, router],
  );

  const chatPackage = React.useMemo(
    () => ({ start: startContentPackage, runs: packageRuns }),
    [startContentPackage, packageRuns],
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatSendProvider value={sendFromCard}>
        <ChatPackageProvider value={chatPackage}>
          <Thread
            components={{
              Welcome,
              ComposerPlusMenu: PlusMenu,
              QuickActions,
              ContextChip,
            }}
          />
        </ChatPackageProvider>
      </ChatSendProvider>
    </AssistantRuntimeProvider>
  );
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
