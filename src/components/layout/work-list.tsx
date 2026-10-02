"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { copyText } from "@/lib/works/copy";
import { todayWorkId } from "@/lib/works/work";
import type { WorkStatusValue } from "@/lib/works/work";
import { createWorkAction } from "@/server/actions/work-actions";

// "Recent works" in the sidebar (docs/works.md): every conversation is a Work
// with a title, a one-line subtitle and a status dot. The view is pure (no
// hooks) so it renders and tests without a router; WorkList wires it up.

export type SidebarWork = {
  id: string;
  title: string;
  summary: string | null;
  status: WorkStatusValue;
  // Set only when Works is on: the deterministic per-day Today Work.
  isToday?: boolean;
};

export const WORK_LIST_COPY = {
  heading: "Recent works",
  newWork: "New Work",
  newWorkAria: "Start a new Work",
  empty: "No works yet",
  active: "Active",
  done: "Completed",
  fallbackSummary: "Active work",
  failed: "Couldn't open a new Work. Try again.",
  // New Work never piles up empty rows: while one is still blank, it is opened.
  reused: "You already have an empty Work, so that one is open.",
} as const;

const DOT_CLASS: Record<WorkStatusValue, string> = {
  ACTIVE: "bg-emerald-500",
  DONE: "bg-violet-500",
  ARCHIVED: "bg-muted-foreground/40",
};

export function workHref(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

// The value of ?work= that stands for today's Work before it exists.
export const TODAY_WORK_PARAM = "today";

// The Work highlighted: the URL's, else the newest active one (what a bare
// project URL opens). ?work=today maps to the Today row, or to the virtual one.
export function activeWorkIdOf(
  works: readonly SidebarWork[],
  param: string | null,
  todayKey?: string,
  projectId?: string,
): string | null {
  if (param === TODAY_WORK_PARAM) {
    const todayId =
      todayKey && projectId ? todayWorkId(projectId, todayKey) : null;
    const row = works.find((work) =>
      todayId ? work.id === todayId : work.isToday,
    );
    return row?.id ?? TODAY_WORK_PARAM;
  }
  if (param && works.some((work) => work.id === param)) return param;
  if (param) return param;
  // A bare URL never lands on a Today Work while another active one exists.
  return (
    (
      works.find((work) => work.status === "ACTIVE" && !work.isToday) ??
      works.find((work) => work.status === "ACTIVE")
    )?.id ?? null
  );
}

// What a "New Work" tap does with the server's answer: go to the Work, and when
// it was an existing blank one (not a new row), say so, so the tap never looks
// like it did nothing (it often changes nothing visible: that Work is already
// the open one). Pure, so the rule is testable without a router.
export function applyNewWorkResult(
  projectId: string,
  result:
    | { ok: true; workId: string; reused?: true }
    | { ok: false; message: string },
  handlers: {
    push: (href: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  },
): void {
  if (!result.ok) {
    handlers.error(result.message || WORK_LIST_COPY.failed);
    return;
  }
  if (result.reused) handlers.info(WORK_LIST_COPY.reused);
  handlers.push(workHref(projectId, result.workId));
}

export function WorkListView({
  projectId,
  works,
  activeWorkId,
  creating,
  onNew,
  todayKey,
}: {
  projectId: string;
  works: readonly SidebarWork[];
  activeWorkId: string | null;
  creating: boolean;
  onNew: () => void;
  todayKey?: string;
}) {
  // With a todayKey, today's Work is pinned first (a virtual row until it
  // exists: opening it creates it) and earlier days' Today Works never render.
  let rows: readonly SidebarWork[] = works;
  if (todayKey) {
    const todayId = todayWorkId(projectId, todayKey);
    const todayRow = works.find((work) => work.id === todayId);
    rows = [
      todayRow ?? {
        id: TODAY_WORK_PARAM,
        title: copyText("today.sidebar"),
        summary: null,
        status: "ACTIVE",
        isToday: true,
      },
      ...works.filter((work) => work.id !== todayId && !work.isToday),
    ];
  }
  // The pinned Today row always opens "whichever day it is when clicked": a tab
  // left open past midnight must not reopen yesterday's id.
  const pinnedTodayId = todayKey ? todayWorkId(projectId, todayKey) : null;
  return (
    <div className="space-y-0.5" data-slot="work-list">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-sidebar-foreground/45 uppercase">
          {WORK_LIST_COPY.heading}
        </span>
        <button
          type="button"
          onClick={onNew}
          disabled={creating}
          aria-label={WORK_LIST_COPY.newWorkAria}
          className="-mr-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {creating ? (
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <Plus aria-hidden="true" className="size-3" />
          )}
          {WORK_LIST_COPY.newWork}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-sidebar-foreground/50">
          {WORK_LIST_COPY.empty}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((work) => {
            const active = work.id === activeWorkId;
            return (
              <li key={work.id}>
                <Link
                  href={workHref(
                    projectId,
                    work.id === pinnedTodayId ? TODAY_WORK_PARAM : work.id,
                  )}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {work.isToday ? copyText("today.sidebar") : work.title}
                    </span>
                    <span className="block truncate text-xs text-sidebar-foreground/55">
                      {work.summary ??
                        (work.isToday
                          ? copyText("today.sidebarSummary")
                          : work.status === "DONE"
                            ? WORK_LIST_COPY.done
                            : WORK_LIST_COPY.fallbackSummary)}
                    </span>
                  </span>
                  <span
                    role="img"
                    aria-label={
                      work.status === "DONE"
                        ? WORK_LIST_COPY.done
                        : WORK_LIST_COPY.active
                    }
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      DOT_CLASS[work.status],
                    )}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function WorkList({
  projectId,
  works,
  todayKey,
}: {
  projectId: string;
  works: readonly SidebarWork[];
  todayKey?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [creating, startTransition] = React.useTransition();
  const onPlainChat = !searchParams.get("panel") && !searchParams.get("entity");
  const activeWorkId = onPlainChat
    ? activeWorkIdOf(works, searchParams.get("work"), todayKey, projectId)
    : null;

  // The Work on screen: when it is the empty one, New Work keeps the person there.
  const currentWorkId =
    activeWorkId && activeWorkId !== TODAY_WORK_PARAM ? activeWorkId : undefined;
  const onNew = React.useCallback(() => {
    startTransition(async () => {
      const result = await createWorkAction(projectId, undefined, currentWorkId);
      applyNewWorkResult(projectId, result, {
        push: (href) => router.push(href),
        error: (message) => toast.error(message),
        info: (message) => toast.info(message),
      });
    });
  }, [projectId, router, currentWorkId]);

  return (
    <WorkListView
      projectId={projectId}
      works={works}
      activeWorkId={activeWorkId}
      creating={creating}
      onNew={onNew}
      todayKey={todayKey}
    />
  );
}
