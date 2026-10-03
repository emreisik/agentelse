"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  Gem,
  Library,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Plug,
  Settings2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  buildHubHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";
import {
  SIDEBAR_ACTIVE_CLASS,
  SIDEBAR_ITEM_CLASS,
} from "@/components/layout/sidebar-item";
import { WorkNav, type SidebarWork } from "@/components/layout/work-list";
import { withWorkParam } from "@/lib/works/work";

type NavItem = {
  label: string;
  icon: LucideIcon;
} & (
  | { panel: PanelKey; sub?: string }
  | { route: "takvim" | "integrations" | "ads" }
  | { home: true }
);

type NavGroup = {
  title: string | null;
  items: NavItem[];
  // Sits at the bottom of the sidebar instead of following the group above.
  pinnedToBottom?: boolean;
};

// What the project's day-to-day work needs, grouped by what it's for. "Agency
// Desk" is the project's free-text agency chat (ProjectChat) — everything,
// decisions included, happens in that one screen (pending cards in the chat).
// With Works on it is not shown: like ChatGPT, New Chat is on top, the groups
// follow, and the conversations are "Recents" below them (work-list.tsx);
// opening the project starts a new chat anyway.
// The rarely used panels (Setup, Departments, Human Action) are not listed
// here: they live in the header's Advanced menu (project-tools-menu.tsx), with
// its attention dot. Settings is the one of them that stays in the sidebar, as
// a single line at the bottom: publishing times, spending limits, Autopilot and
// deleting the project are only there.
const GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ label: "Agency Desk", icon: MessagesSquare, home: true }],
  },
  {
    title: "Create",
    items: [
      { label: "Brand Brain", icon: Gem, panel: "brand-brain" },
      { label: "Ideas", icon: Sparkles, panel: "ideas" },
      { label: "Work", icon: ListChecks, panel: "work", sub: "tasks" },
      { label: "Library", icon: Library, panel: "library" },
      { label: "Content Calendar", icon: CalendarDays, route: "takvim" },
    ],
  },
  {
    title: "Channels",
    items: [
      { label: "Ads Manager", icon: Megaphone, route: "ads" },
      { label: "Connectors", icon: Plug, route: "integrations" },
    ],
  },
  {
    title: null,
    pinnedToBottom: true,
    items: [{ label: "Settings", icon: Settings2, panel: "settings" }],
  },
];

// Same logic as ChatGPT's chat history: the project is picked in the
// header's brand switcher, and this lists the selected project's nav links.
export function SidebarNav({
  activeProjectId,
  toolBadges = {},
  works,
  openWorkUntouched = false,
}: {
  activeProjectId?: string;
  toolBadges?: Partial<Record<PanelKey, number>>;
  // Recents (docs/works.md). Absent when Works is off: the nav renders exactly
  // as before.
  works?: readonly SidebarWork[];
  // Works: the chat on screen is still the new chat (see AppShell).
  openWorkUntouched?: boolean;
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

  if (!activeProjectId) {
    return <nav className="flex flex-1 flex-col px-3 py-3 text-sm" />;
  }

  const renderGroup = (group: NavGroup, index: number) => (
    <div
      key={group.title ?? index}
      className={cn(
        "space-y-0.5",
        group.pinnedToBottom && "mt-auto",
        works && "shrink-0",
      )}
    >
      {group.title ? (
        <div className="px-2.5 pb-1 text-[10px] font-semibold tracking-[0.1em] text-sidebar-foreground/45 uppercase">
          {group.title}
        </div>
      ) : null}
      {group.items.map((item) => {
        const Icon = item.icon;
        let href: string;
        let active: boolean;
        let badge = 0;
        if ("panel" in item) {
          href = buildHubHref(activeProjectId, {
            panel: item.panel,
            sub: item.sub ?? null,
            entity: null,
          });
          // With Works, a panel keeps the chat it was opened from, so its
          // "Back to chat" returns there instead of starting a new one.
          if (works) href = withWorkParam(href, searchParams.get("work"));
          active = activePanel === item.panel;
          badge = toolBadges[item.panel] ?? 0;
        } else if ("route" in item) {
          href = `/projects/${activeProjectId}/${item.route}`;
          active = pathname === href;
        } else {
          // Agency Desk: only without Works (see GROUPS).
          href = `/projects/${activeProjectId}`;
          active = isPlainChat;
        }
        return (
          <Link
            key={item.label}
            href={href}
            scroll={"panel" in item ? false : undefined}
            className={cn(
              SIDEBAR_ITEM_CLASS,
              active ? SIDEBAR_ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
            )}
          >
            <Icon className="size-4 shrink-0 opacity-80" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {badge > 0 ? (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-semibold tabular-nums text-warning">
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );

  if (!works) {
    return (
      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-sm">
        {GROUPS.map(renderGroup)}
      </nav>
    );
  }

  // Works: Recents takes the height the groups leave and scrolls on its own;
  // the nav itself scrolls only when even that does not fit (a short window).
  const groups = GROUPS.filter(
    (group) => !group.items.some((item) => "home" in item),
  );
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-sm">
      <WorkNav
        projectId={activeProjectId}
        works={works}
        openWorkUntouched={openWorkUntouched}
        top={groups.filter((group) => !group.pinnedToBottom).map(renderGroup)}
        bottom={groups.filter((group) => group.pinnedToBottom).map(renderGroup)}
      />
    </nav>
  );
}
