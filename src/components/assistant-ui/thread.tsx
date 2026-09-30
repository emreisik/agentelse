"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { DepartmentKey } from "@prisma/client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/follow-up-suggestions";
import { ImageGenerationPreview } from "@/components/assistant-ui/image-generation-preview";
import type { ImageGenState } from "@/lib/image-progress";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { IdeaEventCard } from "@/components/commands/idea-event-card";
import { AgentelseMark } from "@/components/brand/agentelse-mark";
import { DepartmentBadge } from "@/components/shared/department-badge";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { DEPARTMENT_KEY, DEPARTMENT_COLOR } from "@/lib/labels";
import { shortDate } from "@/lib/dates";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  // Slim bar above the scrollable conversation, outside it (see ThreadRoot
  // below) — spec's "context bar": symbol + "Your creative space" on the
  // left, date/workspace label on the right (see project-chat.tsx's
  // ContextBar). Falls back to nothing when unset.
  ContextBar?: ComponentType | undefined;
  // Replaces the default ComposerAddAttachment as the "+" button's content
  // — the composer's searchable departments/integrations/capability
  // shortcuts menu (see project-chat.tsx / composer-plus-menu.tsx). Falls
  // back to plain file-attach-only behavior when not provided.
  ComposerPlusMenu?: ComponentType | undefined;
  // Persistent quick-start chip row shown above the composer, on every
  // turn (not just the empty/new-chat state — see ThreadSuggestions below
  // for that one) — see project-chat.tsx's QuickActions.
  QuickActions?: ComponentType | undefined;
  // Replaces the composer's plain "Automatic" label — a real indicator
  // that brand context is loaded for this turn (see project-chat.tsx's
  // ContextChip). Falls back to nothing (not a fake claim) when unset.
  ContextChip?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  // Read at mount only: assistant-ui re-focuses whenever this changes, so
  // callers must pass a latched value. Default keeps today's autofocus.
  autoFocusComposer?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ComposerAutoFocusContext = createContext<boolean>(true);

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocusComposer = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);
  const [autoFocus] = useState(autoFocusComposer);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ComposerAutoFocusContext.Provider value={autoFocus}>
        <ThreadRoot isEmpty={isEmpty} />
      </ComposerAutoFocusContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const {
    Welcome = ThreadWelcome,
    QuickActions,
    ContextBar,
  } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col"
      style={{
        // Brand Workspace UI direction (docs/brand-workspace-migration.md
        // §7 §15 §16): conversation column 860px, composer on a plain
        // surface with its own explicit shadow value below at 22px radius.
        ["--thread-max-width" as string]: "860px",
        ["--composer-bg" as string]: "var(--ws-surface)",
        ["--composer-radius" as string]: "22px",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {ContextBar ? <ContextBar /> : null}
      {/* turnAnchor's default is "bottom" (classic chat behavior) —
          deliberately left unset. "top" (new message pins at the top and
          the reply grows below) made autoScroll default to false in
          assistant-ui, causing new system messages brought by LiveRefresh
          (task/approval/creative cards) to never scroll the page to the
          bottom. This holds for streamed replies (CHAT_ENGINE=agent) too:
          following the growing text with the default bottom anchor is
          what we want. */}
      <ThreadPrimitive.Viewport
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-auto scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {QuickActions ? <QuickActions /> : null}
            <Composer />
            <p
              className="px-1 text-center text-[10px]"
              style={{ color: "var(--ws-text-3)" }}
            >
              ✳ Agentelse automatically uses your brand context.
            </p>
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const dateDivider = useAuiState((s) => {
    const custom = s.message.metadata.custom as { dateDivider?: unknown };
    return typeof custom.dateDivider === "string"
      ? custom.dateDivider
      : undefined;
  });
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  // A synthetic day-boundary marker (see project-chat.tsx) — checked before
  // role/isEditing since it changes the whole message chrome (no avatar, no
  // footer, no action bar), not just the content.
  if (dateDivider) return <DateDivider label={dateDivider} />;
  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const DateDivider: FC<{ label: string }> = ({ label }) => (
  <div
    role="separator"
    aria-label={label}
    className="my-1 flex items-center gap-3 px-2"
  >
    <div className="h-px flex-1" style={{ background: "var(--ws-border)" }} />
    <span
      className="text-[11px] font-medium select-none"
      style={{ color: "var(--ws-text-3)" }}
    >
      {label}
    </span>
    <div className="h-px flex-1" style={{ background: "var(--ws-border)" }} />
  </div>
);

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip="Scroll down"
          variant="outline"
          className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
        />
      }
    >
      <ArrowDownIcon />
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        How can I help you today?
      </h1>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger
        send
        render={
          <Button
            variant="ghost"
            className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
          />
        }
      >
        <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
        <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC = () => {
  const autoFocus = useContext(ComposerAutoFocusContext);
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-slot="aui_composer-shell"
            className="border-[var(--ws-border)] data-[dragging=true]:border-ring focus-within:border-[var(--ws-border)] flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[0_8px_35px_rgba(0,0,0,0.05)] transition-[border-color,box-shadow] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[var(--ws-hover)]"
          />
        }
      >
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder="Write down what's on your mind. Let's bring it to life…"
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-14 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
          rows={2}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message"
        />
        <ComposerAction />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  const { ComposerPlusMenu, ContextChip } = useContext(ThreadComponentsContext);
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        {ComposerPlusMenu ? <ComposerPlusMenu /> : <ComposerAddAttachment />}
        {ContextChip ? <ContextChip /> : null}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate
              render={
                <TooltipIconButton
                  tooltip="Dictate"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-dictate size-7 rounded-full"
                  aria-label="Start dictation"
                />
              }
            >
              <MicIcon className="aui-composer-dictate-icon size-4" />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation
              render={
                <TooltipIconButton
                  tooltip="Stop dictation"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                  aria-label="Stop dictation"
                />
              }
            >
              <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            render={
              <TooltipIconButton
                tooltip="Send"
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send size-[33px] rounded-[10px]"
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
                aria-label="Send"
              />
            }
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            render={
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel size-[33px] rounded-[10px]"
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
                aria-label="Stop"
              />
            }
          >
            <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  // Creative/image generation events (see IdeaChatRepository
  // postCreativeLoadingCard/resolveCreativeCard) are carried in the
  // message's metadata.custom.card — if present, a special card is shown
  // INSTEAD OF the normal text/part render (like ChatGPT's loading →
  // result card shown while generating images).
  const card = useAuiState((s) => {
    const custom = s.message.metadata.custom as { card?: unknown };
    return isIdeaEventCardData(custom.card) ? custom.card : undefined;
  });

  // Streamed preview + progress of an image still rendering
  // (CHAT_ENGINE=agent's generate_image): sharpens in place with a 0-100%
  // bar until the finished card replaces it.
  const previewUrl = useAuiState((s) => {
    const custom = s.message.metadata.custom as { previewUrl?: unknown };
    return typeof custom.previewUrl === "string"
      ? custom.previewUrl
      : undefined;
  });
  const imageGen = useAuiState((s) => {
    const custom = s.message.metadata.custom as { imageGen?: unknown };
    const value = custom.imageGen as Partial<ImageGenState> | undefined;
    return value && typeof value.startedAt === "number"
      ? (value as ImageGenState)
      : undefined;
  });

  const commandId = useAuiState((s) => {
    const custom = s.message.metadata.custom as { commandId?: unknown };
    return typeof custom.commandId === "string" ? custom.commandId : undefined;
  });

  // For event messages tied to a SINGLE department (task/creative
  // completion — see IdeaChatRepository.postSystemMessage),
  // metadata.custom.departmentKey is set — for quick visual scanning, a
  // thin stripe in that department's color is applied to the left edge of
  // the message content (the same visual language as the kanban card, see
  // idea-lens-board.tsx).
  const departmentKey = useAuiState((s) => {
    const custom = s.message.metadata.custom as { departmentKey?: unknown };
    const key = custom.departmentKey;
    return typeof key === "string" && key in DEPARTMENT_KEY
      ? (key as DepartmentKey)
      : undefined;
  });

  // Read-time idea label (see page.tsx / project-chat.tsx) — the single
  // project-wide chat is now one flat chronological timeline, so this pill
  // is the only thing that still shows which initiative a given event
  // belongs to. Header-level (not card-level) so it covers plain-text
  // SYSTEM events the same way as carded ones. Absent inside an idea's own
  // thread, where it would be redundant on every message.
  const ideaTitle = useAuiState((s) => {
    const custom = s.message.metadata.custom as { ideaTitle?: unknown };
    return typeof custom.ideaTitle === "string" ? custom.ideaTitle : undefined;
  });

  // Alongside ideaTitle — lets the pill below link to the isolated per-idea
  // thread view (see sidebar-nav.tsx's matching &thread=1 link and
  // page.tsx's wantsThreadView) instead of only displaying the name.
  const ideaId = useAuiState((s) => {
    const custom = s.message.metadata.custom as { ideaId?: unknown };
    return typeof custom.ideaId === "string" ? custom.ideaId : undefined;
  });
  const { projectId } = useParams<{ projectId: string }>();

  // DOM anchor for the "Initiatives" sidebar list's #idea-<id> deep link
  // (see project-chat.tsx) — set on whichever message is the first one for
  // that idea, user or assistant.
  const anchorId = useAuiState((s) => {
    const custom = s.message.metadata.custom as { anchorId?: unknown };
    return typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  });

  const createdAt = useAuiState((s) => s.message.createdAt);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      id={anchorId}
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 flex items-start gap-3 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: "var(--ws-accent)" }}
      >
        <AgentelseMark
          className="size-3.5"
          style={{ color: "var(--ws-on-accent)" }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-1.5 px-2">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            Agentelse
          </span>
          <span className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
            Your creative partner
          </span>
          {ideaTitle ? (
            ideaId ? (
              <Link
                href={`/projects/${projectId}?entity=idea:${ideaId}&thread=1`}
                scroll={false}
                title="Open isolated thread view"
                className="ml-0.5 truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text-3)",
                  maxWidth: 180,
                }}
              >
                {ideaTitle}
              </Link>
            ) : (
              <span
                className="ml-0.5 truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text-3)",
                  maxWidth: 180,
                }}
              >
                {ideaTitle}
              </span>
            )
          ) : null}
        </div>
        <div
          data-slot="aui_assistant-message-content"
          className="text-foreground border-l-[3px] border-l-transparent px-2 leading-relaxed wrap-break-word"
          style={
            departmentKey
              ? { borderLeftColor: DEPARTMENT_COLOR[departmentKey] }
              : undefined
          }
        >
          {imageGen && (
            <ImageGenerationPreview state={imageGen} previewUrl={previewUrl} />
          )}
          {card && <IdeaEventCard card={card} commandId={commandId} />}
          <MessagePrimitive.GroupedParts
            groupBy={groupPartByType({
              reasoning: ["group-chainOfThought", "group-reasoning"],
              "tool-call": ["group-chainOfThought", "group-tool"],
              "standalone-tool-call": [],
            })}
          >
            {({ part, children }) => {
              switch (part.type) {
                case "group-chainOfThought":
                  return <div data-slot="aui_chain-of-thought">{children}</div>;
                case "group-tool":
                  if (ToolGroup) {
                    return <ToolGroup group={part}>{children}</ToolGroup>;
                  }
                  return (
                    <ToolGroupRoot variant="ghost">
                      <ToolGroupTrigger
                        count={part.indices.length}
                        active={part.status.type === "running"}
                      />
                      <ToolGroupContent>{children}</ToolGroupContent>
                    </ToolGroupRoot>
                  );
                case "group-reasoning": {
                  if (ReasoningGroup) {
                    return (
                      <ReasoningGroup group={part}>{children}</ReasoningGroup>
                    );
                  }
                  const running = part.status.type === "running";
                  return (
                    <ReasoningRoot streaming={running}>
                      <ReasoningTrigger active={running} />
                      <ReasoningContent aria-busy={running}>
                        <ReasoningText>{children}</ReasoningText>
                      </ReasoningContent>
                    </ReasoningRoot>
                  );
                }
                case "text":
                  return <MarkdownText />;
                case "reasoning":
                  return <Reasoning {...part} />;
                case "tool-call":
                  return part.toolUI ?? <ToolFallbackComponent {...part} />;
                case "data":
                  return part.dataRendererUI;
                case "indicator":
                  return (
                    <span
                      data-slot="aui_assistant-message-indicator"
                      className="animate-pulse font-sans"
                      aria-label="Assistant is typing"
                    >
                      {"●"}
                    </span>
                  );
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
          {/* If the card already shows its own department row (see
            idea-event-card.tsx EventCard), we don't show it AGAIN here —
            only for plain-text events (e.g. "Task created") does the
            department appear here with the SAME icon+color as on the
            departments page. */}
          {!card && departmentKey ? (
            <DepartmentBadge
              department={departmentKey}
              size="xs"
              className="mt-1.5"
            />
          ) : null}
          <MessageError />
        </div>

        <div
          data-slot="aui_assistant-message-footer"
          className={cn("ms-2 flex items-center gap-2", ACTION_BAR_HEIGHT)}
        >
          <BranchPicker />
          <AssistantActionBar />
          {createdAt && (
            <span className="text-muted-foreground text-xs">
              {shortDate(createdAt)}
            </span>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}>
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
        </AuiIf>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload
        render={<TooltipIconButton tooltip="Refresh" />}
      >
        <RefreshCwIcon />
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton
              tooltip="More"
              className="data-[state=open]:bg-accent"
            />
          }
        >
          <MoreHorizontalIcon />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown
            render={
              <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none" />
            }
          >
            <DownloadIcon className="size-4" />
            Export as Markdown
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  const createdAt = useAuiState((s) => s.message.createdAt);
  // DOM anchor for the "Initiatives" sidebar list's #idea-<id> deep link
  // (see project-chat.tsx AssistantMessage for the fuller comment) — a WEB
  // turn's user bubble carries it when that message is the idea's founding
  // one.
  const anchorId = useAuiState((s) => {
    const custom = s.message.metadata.custom as { anchorId?: unknown };
    return typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  });

  return (
    <MessagePrimitive.Root
      id={anchorId}
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div
          className="aui-user-message-content peer wrap-break-word rounded-[20px] px-4 py-3 empty:hidden"
          style={{ background: "var(--ws-surface-2)", color: "var(--ws-text)" }}
        >
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      {createdAt && (
        <span
          data-slot="aui_user-message-timestamp"
          className="text-muted-foreground mt-1 text-end text-xs"
        >
          {shortDate(createdAt)}
        </span>
      )}

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit
        render={
          <TooltipIconButton tooltip="Edit" className="aui-user-action-edit" />
        }
      >
        <PencilIcon />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3.5"
              />
            }
          >
            Cancel
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            render={<Button size="sm" className="h-8 rounded-full px-3.5" />}
          >
            Update
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous
        render={<TooltipIconButton tooltip="Previous" />}
      >
        <ChevronLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next render={<TooltipIconButton tooltip="Next" />}>
        <ChevronRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
