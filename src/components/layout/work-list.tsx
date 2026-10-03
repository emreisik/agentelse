"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, SquarePen } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type { WorkStatusValue } from "@/lib/works/work";
import {
  createRecentsAnnouncer,
  visibleRecents,
  type RecentRow,
} from "@/lib/works/recents-announcer";
import {
  WORK_ACTIVITY_EVENT,
  WORK_SETTLED_EVENT,
  activityOf,
  settledOf,
} from "@/lib/works/work-activity";
import { createWorkAction } from "@/server/actions/work-actions";
import {
  SIDEBAR_ACTIVE_CLASS,
  SIDEBAR_ITEM_CLASS,
} from "@/components/layout/sidebar-item";

// The sidebar's conversations, like ChatGPT's (docs/works.md): "New Chat" on
// top, the nav groups under it, then "Recents", which fills the rest of the
// sidebar and scrolls on its own. Every conversation is a Work with a title, a
// one-line subtitle and a status dot. A chat joins Recents with its first
// message; the blank one New Chat opens is not listed. The views are pure (no
// hooks) so they render and test without a router; WorkNav wires them up.

export type SidebarWork = RecentRow;

export const WORK_LIST_COPY = {
  heading: "Recents",
  newWork: "New Chat",
  empty: "No chats yet",
  active: "Active",
  done: "Completed",
  fallbackSummary: "Active work",
  failed: "Couldn't open a new chat. Try again.",
} as const;

const DOT_CLASS: Record<WorkStatusValue, string> = {
  ACTIVE: "bg-emerald-500",
  DONE: "bg-violet-500",
  ARCHIVED: "bg-muted-foreground/40",
};

export function workHref(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

// What the sidebar marks as open. Only the chat screen (the project root with
// no panel or record) has an open chat: the URL's ?work=. New Chat is the open
// line (and not clickable) on the bare URL, where the new chat is being made,
// and in a chat the server says is untouched, until its first message puts it
// in Recents. Not being in Recents alone says nothing: an archived chat, an
// old one past the list's end or a Today brief is no new chat.
export function sidebarSelection(input: {
  projectId: string;
  pathname: string;
  search: { get(name: string): string | null };
  recents: readonly { id: string }[];
  openWorkUntouched: boolean;
}): { activeWorkId: string | null; newChatActive: boolean } {
  const onChat =
    input.pathname === `/projects/${input.projectId}` &&
    !input.search.get("panel") &&
    !input.search.get("entity");
  if (!onChat) return { activeWorkId: null, newChatActive: false };
  const activeWorkId = input.search.get("work")?.trim() || null;
  if (activeWorkId === null) return { activeWorkId, newChatActive: true };
  const listed = input.recents.some((work) => work.id === activeWorkId);
  return { activeWorkId, newChatActive: input.openWorkUntouched && !listed };
}

// What a "New Chat" tap does with the server's answer: go to the chat (the
// project's blank one when it has one, like ChatGPT nothing is said about it).
// Pure, so the rule is testable without a router.
export function applyNewWorkResult(
  projectId: string,
  result: { ok: true; workId: string } | { ok: false; message: string },
  handlers: {
    push: (href: string) => void;
    error: (message: string) => void;
  },
): void {
  if (!result.ok) {
    handlers.error(result.message || WORK_LIST_COPY.failed);
    return;
  }
  handlers.push(workHref(projectId, result.workId));
}

// Selected (the new chat is the one on screen) it is not clickable: there is
// nothing newer to open. It keeps the selected look rather than a dimmed one;
// only a chat being opened dims it.
export function NewChatView({
  active,
  creating,
  onNew,
}: {
  active: boolean;
  creating: boolean;
  onNew: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onNew}
      disabled={active || creating}
      aria-current={active ? "page" : undefined}
      className={cn(
        SIDEBAR_ITEM_CLASS,
        "w-full shrink-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
        active ? SIDEBAR_ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
        creating && "opacity-60",
      )}
    >
      {creating ? (
        <Loader2
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin opacity-80"
        />
      ) : (
        <SquarePen aria-hidden="true" className="size-4 shrink-0 opacity-80" />
      )}
      <span className="min-w-0 flex-1 truncate">{WORK_LIST_COPY.newWork}</span>
    </button>
  );
}

export function RecentsView({
  projectId,
  works,
  activeWorkId,
}: {
  projectId: string;
  works: readonly SidebarWork[];
  activeWorkId: string | null;
}) {
  const headingId = React.useId();
  return (
    <div className="flex min-h-28 flex-1 flex-col" data-slot="work-list">
      <div
        id={headingId}
        className="shrink-0 px-2.5 pb-1 text-[10px] font-semibold tracking-[0.1em] text-sidebar-foreground/45 uppercase"
      >
        {WORK_LIST_COPY.heading}
      </div>
      {works.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-sidebar-foreground/50">
          {WORK_LIST_COPY.empty}
        </p>
      ) : (
        <ul
          aria-labelledby={headingId}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto"
        >
          {works.map((work) => {
            const active = work.id === activeWorkId;
            return (
              <li key={work.id}>
                <Link
                  href={workHref(projectId, work.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    // The ring is inset: the list scrolls, so an outer ring
                    // would be clipped at its edges.
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-foreground/60",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {work.title}
                    </span>
                    <span className="block truncate text-xs text-sidebar-foreground/55">
                      {work.summary ??
                        (work.status === "DONE"
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

// New Chat, then the nav groups the sidebar passes in (`top`), then Recents,
// then the bottom group (Settings).
export function WorkNav({
  projectId,
  works,
  openWorkUntouched,
  top,
  bottom,
}: {
  projectId: string;
  works: readonly SidebarWork[];
  openWorkUntouched: boolean;
  top: React.ReactNode;
  bottom: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [creating, startTransition] = React.useTransition();

  // A chat joins Recents the moment a message is sent in it and stays through
  // every server list until its turn is over (recents-announcer.ts).
  const [announcer] = React.useState(createRecentsAnnouncer);
  React.useEffect(() => {
    announcer.sync(works);
  });
  React.useEffect(() => {
    const onSent = (event: Event) => {
      const activity = activityOf(projectId, (event as CustomEvent).detail);
      if (activity) announcer.announce(activity);
    };
    const onSettled = (event: Event) => {
      const settled = settledOf(projectId, (event as CustomEvent).detail);
      if (settled) announcer.settle(settled.workId);
    };
    window.addEventListener(WORK_ACTIVITY_EVENT, onSent);
    window.addEventListener(WORK_SETTLED_EVENT, onSettled);
    return () => {
      window.removeEventListener(WORK_ACTIVITY_EVENT, onSent);
      window.removeEventListener(WORK_SETTLED_EVENT, onSettled);
    };
  }, [projectId, announcer]);
  const announced = React.useSyncExternalStore(
    announcer.subscribe,
    announcer.getSnapshot,
    announcer.getSnapshot,
  );
  const rows = visibleRecents(works, announced);

  const { activeWorkId, newChatActive } = sidebarSelection({
    projectId,
    pathname,
    search: searchParams,
    recents: rows,
    openWorkUntouched,
  });

  // The chat on screen is a hint: when it is the blank one, New Chat stays there.
  const onNew = React.useCallback(() => {
    startTransition(async () => {
      try {
        const result = await createWorkAction(
          projectId,
          undefined,
          activeWorkId ?? undefined,
        );
        applyNewWorkResult(projectId, result, {
          push: (href) => router.push(href),
          error: (message) => toast.error(message),
        });
      } catch {
        // A dropped network or a redeploy: say so instead of an error page.
        toast.error(WORK_LIST_COPY.failed);
      }
    });
  }, [projectId, router, activeWorkId]);

  return (
    <>
      <NewChatView active={newChatActive} creating={creating} onNew={onNew} />
      {top}
      <RecentsView
        projectId={projectId}
        works={rows}
        activeWorkId={activeWorkId}
      />
      {bottom}
    </>
  );
}
