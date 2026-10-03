"use client";

import { Check, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { WorkStatusValue } from "@/lib/works/work";
import { copyText } from "@/lib/works/copy";
import { WORK_TITLE_MAX } from "@/lib/works/work";
import {
  archiveWorkAction,
  completeWorkAction,
  deleteWorkAction,
  renameWorkAction,
  reopenWorkAction,
} from "@/server/actions/work-actions";

// The bar above a Work's conversation: title, status line, Complete / Reopen and
// the "…" menu (docs/works.md). A new chat nobody has written in yet shows only
// the title and the status line: there is nothing to complete, rename, archive
// or delete, so the actions appear with its first message.

export const WORK_HEADER_COPY = {
  complete: "Complete",
  reopen: "Reopen",
  menuAria: "Work options",
  rename: "Rename",
  archive: "Archive",
  delete: "Delete",
  deleteConfirm:
    "Delete this Work and its conversation? Pieces already made stay in your library.",
  saveName: "Save name",
  nameAria: "Work name",
  done: "Completed",
  working: "Agentelse is working on this Work",
  active: "Active",
  failed: "That didn't work. Try again.",
} as const;

// The id of the daily-brief card's heading (the card renders it).
export const DAILY_BRIEF_HEADING_ID = "daily-brief";

export function WorkHeaderView({
  title,
  status,
  working,
  editing,
  draft,
  pending,
  onDraft,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onComplete,
  onReopen,
  onArchive,
  onDelete,
  isToday = false,
  staleDay = false,
  untouched = false,
  openTodayHref,
  onJumpToBrief,
}: {
  title: string;
  status: WorkStatusValue;
  working: boolean;
  editing: boolean;
  draft: string;
  pending: boolean;
  onDraft: (value: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onDelete: () => void;
  // Today Work (Works wave 2): cannot be completed, archived, renamed or
  // deleted (the server refuses those too); a stale day links to today.
  isToday?: boolean;
  staleDay?: boolean;
  // Still the new chat (WorkRepository.isUntouched): no actions yet.
  untouched?: boolean;
  openTodayHref?: string;
  onJumpToBrief?: () => void;
}) {
  const done = status === "DONE";
  const showWorking = working && !done;
  // Never applies to a completed or a Today Work, whatever the flag says.
  const quiet = untouched && !isToday && !done;
  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 sm:px-6"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSaveEdit();
            }}
            className="flex items-center gap-2"
          >
            <Input
              autoFocus
              value={draft}
              maxLength={WORK_TITLE_MAX}
              aria-label={WORK_HEADER_COPY.nameAria}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onCancelEdit();
              }}
              className="h-9 max-w-sm"
            />
            <Button type="submit" size="sm" disabled={pending} className="min-h-9">
              {WORK_HEADER_COPY.saveName}
            </Button>
          </form>
        ) : (
          <h1
            className="truncate text-base font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {title}
          </h1>
        )}
        <p
          className="mt-0.5 flex items-center gap-1.5 truncate text-xs"
          style={{ color: "var(--ws-text-3)" }}
        >
          <span
            aria-hidden="true"
            className={
              done
                ? "size-1.5 shrink-0 rounded-full bg-violet-500"
                : showWorking
                  ? "size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
                  : "size-1.5 shrink-0 rounded-full bg-emerald-500"
            }
          />
          {/* Always mounted: a live region that appears already holding its
              text is not announced, one whose text changes is. */}
          <span role="status" className="sr-only">
            {showWorking ? WORK_HEADER_COPY.working : ""}
          </span>
          {showWorking ? (
            <span aria-hidden="true">{WORK_HEADER_COPY.working}</span>
          ) : done ? (
            WORK_HEADER_COPY.done
          ) : (
            WORK_HEADER_COPY.active
          )}
          {isToday && staleDay && openTodayHref ? (
            <Link
              href={openTodayHref}
              className="ml-1 inline-flex min-h-11 shrink-0 items-center font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{ color: "var(--ws-text-2)" }}
            >
              {copyText("today.openToday")}
            </Link>
          ) : null}
        </p>
      </div>

      {quiet ? null : isToday ? (
        staleDay ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onJumpToBrief}
            className="min-h-11 px-3"
          >
            {copyText("today.jump")}
          </Button>
        )
      ) : done ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onReopen}
          className="min-h-11 px-3"
        >
          {WORK_HEADER_COPY.reopen}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onComplete}
          className="min-h-11 gap-1.5 px-3"
        >
          <Check aria-hidden="true" className="size-3.5" />
          {WORK_HEADER_COPY.complete}
        </Button>
      )}

      {quiet || isToday ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={WORK_HEADER_COPY.menuAria}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onStartEdit}>
              {WORK_HEADER_COPY.rename}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchive}>
              {WORK_HEADER_COPY.archive}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              {WORK_HEADER_COPY.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}

export function WorkHeader({
  projectId,
  workId,
  title,
  status,
  working,
  isToday,
  staleDay,
  untouched,
}: {
  projectId: string;
  workId: string;
  title: string;
  status: WorkStatusValue;
  working: boolean;
  isToday?: boolean;
  staleDay?: boolean;
  // Still the new chat: the bar shows no actions (see WorkHeaderView).
  untouched?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);

  const run = React.useCallback(
    (
      call: () => Promise<{ ok: boolean; message?: string }>,
      after?: () => void,
    ) => {
      startTransition(async () => {
        const result = await call();
        if (!result.ok) {
          toast.error(result.message || WORK_HEADER_COPY.failed);
          return;
        }
        after?.();
        router.refresh();
      });
    },
    [router],
  );

  return (
    <WorkHeaderView
      title={title}
      working={working}
      isToday={isToday}
      staleDay={staleDay}
      untouched={untouched}
      openTodayHref={`/projects/${projectId}?work=today`}
      onJumpToBrief={() => {
        const heading = document.getElementById(DAILY_BRIEF_HEADING_ID);
        if (!heading) return;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        heading.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        heading.focus({ preventScroll: true });
      }}
      status={status}
      editing={editing}
      draft={draft}
      pending={pending}
      onDraft={setDraft}
      onStartEdit={() => {
        setDraft(title);
        setEditing(true);
      }}
      onCancelEdit={() => setEditing(false)}
      onSaveEdit={() =>
        run(
          () => renameWorkAction(projectId, workId, draft),
          () => setEditing(false),
        )
      }
      onComplete={() => run(() => completeWorkAction(projectId, workId))}
      onReopen={() => run(() => reopenWorkAction(projectId, workId))}
      onArchive={() =>
        run(
          () => archiveWorkAction(projectId, workId),
          () => router.push(`/projects/${projectId}`),
        )
      }
      onDelete={() => {
        if (!window.confirm(WORK_HEADER_COPY.deleteConfirm)) return;
        run(
          () => deleteWorkAction(projectId, workId),
          () => router.push(`/projects/${projectId}`),
        );
      }}
    />
  );
}
