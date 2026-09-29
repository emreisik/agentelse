"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  Gem,
  Lightbulb,
  Library,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Plug,
  Radio,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Target,
  Users2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  buildHubHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";

type NavItem = {
  label: string;
  icon: LucideIcon;
} & (
  | { panel: PanelKey; sub?: string }
  | { route: "takvim" | "integrations" | "ads" }
  | { home: true }
);

type NavGroup = { title: string | null; items: NavItem[] };

// Every entry the header's Advanced menu (project-tools-menu.tsx) offers is
// listed here too, grouped by what it's for. "Agency Desk" is the project's
// free-text agency chat (ProjectChat) — everything, decisions included,
// happens in that one screen (see DecisionsBar).
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
    title: "Insights",
    items: [
      { label: "Signals", icon: Radio, panel: "signals" },
      {
        label: "Insights & Opportunities",
        icon: Lightbulb,
        panel: "insights-opportunities",
      },
      { label: "Goals", icon: Target, panel: "goals" },
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
    title: "System",
    items: [
      { label: "Setup", icon: SlidersHorizontal, panel: "setup" },
      { label: "Departments", icon: Users2, panel: "departments" },
      { label: "Settings", icon: Settings2, panel: "settings" },
    ],
  },
];

const ITEM_CLASS =
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors";
const ACTIVE_CLASS =
  "bg-sidebar-accent font-medium text-sidebar-accent-foreground";

// Same logic as ChatGPT's chat history: the project is picked in the
// header's brand switcher, and this lists the selected project's nav links.
export function SidebarNav({
  activeProjectId,
  toolBadges = {},
}: {
  activeProjectId?: string;
  toolBadges?: Partial<Record<PanelKey, number>>;
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

  return (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-3 text-sm">
      {GROUPS.map((group, index) => (
        <div key={group.title ?? index} className="space-y-0.5">
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
              active = activePanel === item.panel;
              badge = toolBadges[item.panel] ?? 0;
            } else if ("route" in item) {
              href = `/projects/${activeProjectId}/${item.route}`;
              active = pathname === href;
            } else {
              href = `/projects/${activeProjectId}`;
              active = isPlainChat;
            }
            return (
              <Link
                key={item.label}
                href={href}
                scroll={"panel" in item ? false : undefined}
                className={cn(
                  ITEM_CLASS,
                  active ? ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
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
      ))}
    </nav>
  );
}
