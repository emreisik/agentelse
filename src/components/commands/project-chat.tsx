"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
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

import type { CapabilityKey, SocialPlatform } from "@prisma/client";

import {
  submitChatMessageAction,
  type ChatMessageResult,
} from "@/server/actions/command-actions";
import { submitComposerShortcutAction } from "@/server/actions/composer-shortcut-actions";
import { Thread } from "@/components/assistant-ui/thread";
import { ComposerPlusMenu } from "@/components/commands/composer-plus-menu";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";
import type { IdeaEventCardData } from "@/types/idea-event-card";

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
  createdAt: string;
};

type FlatMessage =
  | {
      id: string;
      role: "user";
      text: string;
      attachments: (ChatAttachment | LocalAttachment)[];
      createdAt: string;
    }
  | {
      id: string;
      role: "assistant";
      text: string;
      card?: IdeaEventCardData;
      departmentKey?: DepartmentKey;
      error?: boolean;
      createdAt: string;
    };

const CHAT_ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,text/markdown";

const STATUS_NOTE: Record<string, string> = {
  PLANNED: "Task created",
  APPROVAL_HANDLED: "Approval processed",
  UNCLEAR: "Awaiting clarification",
  ERROR: "Error",
};

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
}) {
  const [localTurns, setLocalTurns] = React.useState<LocalTurn[]>([]);
  const [isSending, startTransition] = React.useTransition();
  const attachmentAdapter = React.useMemo(
    () => new ProjectChatAttachmentAdapter(),
    [],
  );

  // Drop local copies of turns once they land in the server list.
  const serverIds = React.useMemo(
    () => new Set(turns.map((turn) => turn.commandId)),
    [turns],
  );
  const visibleLocal = localTurns.filter(
    (turn) => !turn.commandId || !serverIds.has(turn.commandId),
  );

  const messages = React.useMemo<FlatMessage[]>(() => {
    const out: FlatMessage[] = [];
    for (const turn of turns) {
      if (turn.source === "SYSTEM") {
        // Pipeline event: no user bubble, just an assistant note — if
        // card data is present (creative generation), CreativeCard is
        // shown instead of plain text (see convertMessage).
        if (turn.reply) {
          out.push({
            id: `${turn.commandId}-a`,
            role: "assistant",
            text: turn.reply,
            card: turn.card,
            departmentKey: turn.departmentKey,
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
        createdAt: turn.createdAt,
      });
      if (turn.reply) {
        const note = turn.replyStatus
          ? STATUS_NOTE[turn.replyStatus]
          : undefined;
        out.push({
          id: `${turn.commandId}-a`,
          role: "assistant",
          text: note ? `${turn.reply}\n\n*${note}*` : turn.reply,
          // A user turn can also carry a card reply (limit-notice) — when
          // present it replaces the plain text, same as SYSTEM events.
          card: turn.card,
          // Which team it went to, alongside the "Task created" note, is
          // now shown NOT as plain text but with the actual
          // DepartmentBadge (department color+icon) rendered by
          // thread.tsx from departmentKey.
          departmentKey: turn.departmentKey,
          createdAt: turn.createdAt,
        });
      }
    }
    for (const turn of visibleLocal) {
      out.push({
        id: `${turn.key}-u`,
        role: "user",
        text: turn.text,
        attachments: turn.attachments,
        createdAt: turn.createdAt,
      });
      if (turn.state === "pending") {
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text: "Thinking…",
          createdAt: turn.createdAt,
        });
      } else if (turn.reply) {
        out.push({
          id: `${turn.key}-a`,
          role: "assistant",
          text: turn.reply,
          card: turn.card,
          error: turn.state === "error",
          createdAt: turn.createdAt,
        });
      }
    }
    return out;
  }, [turns, visibleLocal]);

  const convertMessage = React.useCallback(
    (message: FlatMessage): ThreadMessageLike => {
      if (message.role === "user") {
        return {
          role: "user",
          content: message.text,
          createdAt: new Date(message.createdAt),
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
      // If card data is present (creative generation — loading/ready/
      // failed), the CreativeCard in thread.tsx is rendered via
      // metadata.custom.card instead of plain text (see AssistantMessage);
      // content is left empty so the same info doesn't show up twice
      // (both as plain text and as a card). departmentKey (whether or not
      // a card is present) is carried through the same metadata.custom —
      // thread.tsx renders it as a side stripe.
      if (message.card || message.departmentKey) {
        return {
          role: "assistant",
          content: message.card ? [] : message.text,
          createdAt: new Date(message.createdAt),
          metadata: {
            custom: {
              card: message.card,
              departmentKey: message.departmentKey,
            },
          },
          status: message.error
            ? { type: "incomplete", reason: "error" }
            : undefined,
        };
      }

      return {
        role: "assistant",
        content: message.text,
        createdAt: new Date(message.createdAt),
        status: message.error
          ? { type: "incomplete", reason: "error" }
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

  const sendMessage = React.useCallback(
    (text: string, files: File[]) => {
      if (!text && files.length === 0) return Promise.resolve();

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
    [runTurn, projectId, ideaId],
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
    ) => {
      return runTurn(request, [], () =>
        submitComposerShortcutAction(
          projectId,
          capability,
          request,
          targetPlatform,
          ideaId,
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
  // an id — see fromThreadMessageLike). Attachments aren't retained past the
  // original send, so a retry only resubmits the original text.
  const onReload = React.useCallback(
    async (parentId: string | null) => {
      const parent = parentId !== null ? messages[Number(parentId)] : undefined;
      if (!parent || parent.role !== "user") {
        toast.error("Can't retry this message.");
        return;
      }
      await sendMessage(parent.text, []);
    },
    [messages, sendMessage],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: isSending,
    onNew,
    onReload,
    adapters: { attachments: attachmentAdapter },
  });

  const Welcome = React.useCallback(
    () => (
      <div className="mb-6 flex flex-col items-center gap-3 px-4 text-center">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <Sparkles className="size-4" />
        </span>
        <p className="max-w-sm text-sm text-muted-foreground">
          Hi! I&apos;m here for {projectName}. Ask for content, ask a question,
          or give instructions by attaching an image/file — for example
          &quot;prepare an Instagram post using this image&quot;.
        </p>
      </div>
    ),
    [projectName],
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={{ Welcome, ComposerPlusMenu: PlusMenu }} />
    </AssistantRuntimeProvider>
  );
}
