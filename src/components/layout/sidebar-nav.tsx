"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  ClipboardList,
  Ellipsis,
  Gem,
  Library,
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
  SIDEBAR_RAIL_ITEM_CLASS,
} from "@/components/layout/sidebar-item";
import {
  RailTip,
  useSidebarCollapsed,
} from "@/components/layout/sidebar-collapse";
import { WorkNav, type SidebarWork } from "@/components/layout/work-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { withWorkParam } from "@/lib/works/work";

type NavItem = {
  label: string;
  icon: LucideIcon;
} & (
  | { panel: PanelKey; sub?: string }
  | { route: "takvim" | "integrations" | "ads" }
  | { home: true }
);

// Like ChatGPT's sidebar: a short list of what the project's day-to-day work
// needs, with no group titles, then "Explore" for the rest, so Recents gets
// most of the height. "Agency Desk" is the project's free-text agency chat
// (ProjectChat); with Works on it is not shown: New Chat is on top and the
// conversations are "Recents" below (work-list.tsx).
const PRIMARY: NavItem[] = [
  { label: "Agency Desk", icon: MessagesSquare, home: true },
  { label: "Brand Brain", icon: Gem, panel: "brand-brain" },
  { label: "Ideas", icon: Sparkles, panel: "ideas" },
  { label: "Library", icon: Library, panel: "library" },
  { label: "Content Calendar", icon: CalendarDays, route: "takvim" },
];

// "Explore" opens these to the right, like ChatGPT's: the channels, then the
// task log and Settings (ADVANCED_PANEL_KEYS) — publishing times, spending
// limits and deleting the project are only in Settings.
export const EXPLORE: NavItem[][] = [
  [
    { label: "Ads Manager", icon: Megaphone, route: "ads" },
    { label: "Connectors", icon: Plug, route: "integrations" },
  ],
  [
    { label: "Task log", icon: ClipboardList, panel: "work" },
    { label: "Settings", icon: Settings2, panel: "settings" },
  ],
];

export const EXPLORE_COPY = { label: "Explore" } as const;

const BADGE_CLASS =
  "flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-semibold tabular-nums text-warning";

// The project is picked in the sidebar's brand switcher
// (workspace-sidebar.tsx), and this lists the selected project's nav links.
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
  // The docked sidebar collapsed to its icon rail (sidebar-collapse.tsx):
  // icons only, labels in tooltips, no Recents.
  const rail = useSidebarCollapsed();
  const navClass = rail ? "px-2" : "px-3";
  const activeEntity = searchParams.get("entity");
  const activePanel = searchParams.get("panel");
  const isPlainChat =
    Boolean(activeProjectId) &&
    !activeEntity &&
    !activePanel &&
    pathname === `/projects/${activeProjectId}`;

  if (!activeProjectId) {
    return (
      <nav className={cn("flex flex-1 flex-col py-3 text-sm", navClass)} />
    );
  }

  const resolve = (item: NavItem) => {
    if ("panel" in item) {
      let href = buildHubHref(activeProjectId, {
        panel: item.panel,
        sub: item.sub ?? null,
        entity: null,
      });
      // With Works, a panel keeps the chat it was opened from, so its
      // "Back to chat" returns there instead of starting a new one.
      if (works) href = withWorkParam(href, searchParams.get("work"));
      return {
        href,
        active: activePanel === item.panel,
        badge: toolBadges[item.panel] ?? 0,
      };
    }
    if ("route" in item) {
      const href = `/projects/${activeProjectId}/${item.route}`;
      return { href, active: pathname === href, badge: 0 };
    }
    // Agency Desk: only without Works (see PRIMARY).
    return {
      href: `/projects/${activeProjectId}`,
      active: isPlainChat,
      badge: 0,
    };
  };

  const primary = PRIMARY.filter((item) => !(works && "home" in item));
  const explore = EXPLORE.map((group) =>
    group.map((item) => ({ item, ...resolve(item) })),
  );

  const items = (
    <>
      {primary.map((item) => {
        const Icon = item.icon;
        const { href, active, badge } = resolve(item);
        return (
          <RailTip key={item.label} label={item.label}>
            <Link
              href={href}
              scroll={"panel" in item ? false : undefined}
              aria-label={rail ? item.label : undefined}
              className={cn(
                rail ? SIDEBAR_RAIL_ITEM_CLASS : SIDEBAR_ITEM_CLASS,
                active ? SIDEBAR_ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
              )}
            >
              <Icon className="size-4 shrink-0 opacity-80" />
              {rail ? (
                badge > 0 ? (
                  <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warning" />
                ) : null
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span className={BADGE_CLASS}>{badge}</span>
                  ) : null}
                </>
              )}
            </Link>
          </RailTip>
        );
      })}
      <ExploreMenu groups={explore} rail={rail} />
    </>
  );

  if (!works) {
    return (
      <nav
        className={cn(
          "flex flex-1 flex-col space-y-0.5 overflow-y-auto py-2 text-sm",
          navClass,
        )}
      >
        {items}
      </nav>
    );
  }

  // Works: Recents takes the height the list above leaves (at least 60% of the
  // nav) and scrolls on its own; the nav itself scrolls only when even that
  // does not fit (a short window).
  return (
    <nav
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-2 text-sm",
        navClass,
      )}
    >
      <WorkNav
        rail={rail}
        projectId={activeProjectId}
        works={works}
        openWorkUntouched={openWorkUntouched}
        top={items}
      />
    </nav>
  );
}

// "••• Explore": a line like the others that opens its menu to the right. It
// reads as selected while one of its pages is open.
function ExploreMenu({
  groups,
  rail,
}: {
  groups: { item: NavItem; href: string; active: boolean; badge: number }[][];
  rail: boolean;
}) {
  const active = groups.some((group) => group.some((entry) => entry.active));
  const attention = groups.some((group) =>
    group.some((entry) => entry.badge > 0),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={rail ? EXPLORE_COPY.label : undefined}
            title={rail ? EXPLORE_COPY.label : undefined}
            className={cn(
              rail
                ? SIDEBAR_RAIL_ITEM_CLASS
                : cn(SIDEBAR_ITEM_CLASS, "w-full text-left"),
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? SIDEBAR_ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
              "data-popup-open:bg-sidebar-accent",
            )}
          />
        }
      >
        <Ellipsis className="size-4 shrink-0 opacity-80" />
        {rail ? null : (
          <span className="min-w-0 flex-1 truncate">{EXPLORE_COPY.label}</span>
        )}
        {attention ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-warning",
              rail && "absolute top-1.5 right-1.5",
            )}
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-56 rounded-2xl border p-1.5 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        {groups.map((group, index) => (
          <div key={index}>
            {index > 0 ? (
              <DropdownMenuSeparator
                className="my-1"
                style={{ background: "var(--ws-border)" }}
              />
            ) : null}
            {group.map(({ item, href, active: itemActive, badge }) => {
              const Icon = item.icon;
              return (
                <DropdownMenuItem
                  key={item.label}
                  render={
                    <Link
                      href={href}
                      scroll={"panel" in item ? false : undefined}
                    />
                  }
                  aria-current={itemActive ? "page" : undefined}
                  className={cn(
                    "gap-2.5 rounded-xl px-2.5 py-2 text-sm",
                    itemActive && "font-medium",
                  )}
                  style={{ color: "var(--ws-text)" }}
                >
                  <Icon className="size-4 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span className={BADGE_CLASS}>{badge}</span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
