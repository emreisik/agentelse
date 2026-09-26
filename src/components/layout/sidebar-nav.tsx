"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  Gem,
  Library,
  Lightbulb,
  ListChecks,
  Megaphone,
  MessageSquarePlus,
  Plug,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import { MarqueeText } from "@/components/shared/marquee-text";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export type SidebarFlow = {
  id: string;
  kind: "idea" | "workPlan" | "task";
  title: string;
  // Idea flows only — ISO date of that idea's earliest chat message, baked
  // into the link below as `?since=` so the single project chat's default
  // recent-window query is guaranteed to include the #idea-<id> anchor
  // this links to (see page.tsx / app-shell.tsx).
  since?: string;
};

const FLOW_ICON = {
  idea: Lightbulb,
  workPlan: ClipboardList,
  task: ListChecks,
};

// Same logic as ChatGPT's chat history: a compact project selector
// (ProjectSelect) up top, and below it the selected project's "flows" —
// each one the start-to-finish story of an idea/work item, listed as
// individual chat entries. Clicking one opens that flow's full history as
// chat bubbles (see /projects/[projectId]/page.tsx +
// project-flow-view.tsx). "New chat" takes you to the project's free-text
// agency chat (the existing ProjectChat).
export function SidebarNav({
  activeProjectId,
  flows,
}: {
  activeProjectId?: string;
  flows?: SidebarFlow[] | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeEntity = searchParams.get("entity");
  const activePanel = searchParams.get("panel");
  const isPlainChat =
    Boolean(activeProjectId) &&
    !activeEntity &&
    !activePanel &&
    pathname === `/projects/${activeProjectId}`;
  const [flowsOpen, setFlowsOpen] = useState(true);

  return (
    <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-3 text-sm">
      {activeProjectId ? (
        <div className="space-y-0.5">
          <Link
            href={`/projects/${activeProjectId}`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              isPlainChat
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <MessageSquarePlus className="size-4 shrink-0 opacity-80" />
            New chat
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "brand-brain" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "brand-brain"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Gem className="size-4 shrink-0 opacity-80" />
            Brand Brain
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "ideas" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "ideas"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Sparkles className="size-4 shrink-0 opacity-80" />
            Ideas
          </Link>

          <Link
            href={buildHubHref(activeProjectId, {
              panel: "work",
              sub: "tasks",
            })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "work"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <ListChecks className="size-4 shrink-0 opacity-80" />
            Work
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "library" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "library"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Library className="size-4 shrink-0 opacity-80" />
            Library
          </Link>

          <Link
            href={`/projects/${activeProjectId}/takvim`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              pathname === `/projects/${activeProjectId}/takvim`
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <CalendarDays className="size-4 shrink-0 opacity-80" />
            Content Calendar
          </Link>

          <Link
            href={`/projects/${activeProjectId}/integrations`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              pathname === `/projects/${activeProjectId}/integrations`
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Plug className="size-4 shrink-0 opacity-80" />
            Connectors
          </Link>

          <Link
            href={`/projects/${activeProjectId}/ads`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              pathname === `/projects/${activeProjectId}/ads`
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Megaphone className="size-4 shrink-0 opacity-80" />
            Ads Manager
          </Link>

          {flows && flows.length > 0 ? (
            <Collapsible
              open={flowsOpen}
              onOpenChange={setFlowsOpen}
              className="pt-2"
            >
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground/70 uppercase transition-colors hover:text-muted-foreground">
                Initiatives
                <ChevronDown
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    !flowsOpen && "-rotate-90",
                  )}
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-0.5 pt-0.5">
                {flows.map((flow) => {
                  const Icon = FLOW_ICON[flow.kind];
                  // No separate idea thread anymore — every flow jumps
                  // into the ONE project chat, anchored to where that
                  // idea's conversation starts (see page.tsx). Orphan task
                  // flows have no idea-scoped history to anchor to, so
                  // they just land on the plain chat. `since` widens the
                  // chat's default recent-window query so the anchor is
                  // guaranteed to be inside the fetched range.
                  const href =
                    flow.kind === "idea"
                      ? `/projects/${activeProjectId}${
                          flow.since
                            ? `?since=${encodeURIComponent(flow.since)}`
                            : ""
                        }#idea-${flow.id}`
                      : `/projects/${activeProjectId}`;
                  return (
                    <div
                      key={`${flow.kind}-${flow.id}`}
                      className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
                    >
                      <Link
                        href={href}
                        scroll={false}
                        className="flex min-w-0 flex-1 items-center gap-2"
                      >
                        <Icon className="size-4 shrink-0 opacity-70" />
                        <MarqueeText className="flex-1">
                          {flow.title}
                        </MarqueeText>
                      </Link>
                      {flow.kind === "idea" ? (
                        <Link
                          href={`/projects/${activeProjectId}?entity=idea:${flow.id}&thread=1`}
                          scroll={false}
                          title="Open isolated thread view"
                          aria-label="Open isolated thread view"
                          className="shrink-0 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                        >
                          <ExternalLink className="size-3.5" />
                        </Link>
                      ) : null}
                    </div>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
