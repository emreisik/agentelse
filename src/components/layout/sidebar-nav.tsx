"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  Ellipsis,
  Gem,
  Globe,
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
  MODULE_KEYS,
  MODULES,
  type ModuleDef,
  type ModuleKey,
} from "@/lib/modules/catalog";
import {
  buildHubHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";
import {
  SIDEBAR_ACTIVE_CLASS,
  SIDEBAR_HEADING_CLASS,
  SIDEBAR_ITEM_CLASS,
  SIDEBAR_RAIL_ITEM_CLASS,
} from "@/components/layout/sidebar-item";
import {
  RailTip,
  useSidebarCollapsed,
} from "@/components/layout/sidebar-collapse";
import { WorkNav, type SidebarWorks } from "@/components/layout/work-list";
import { ModuleIcon } from "@/components/modules/module-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { withWorkParam } from "@/lib/works/work";
import { WORK_ACTIVITY_EVENT, activityOf } from "@/lib/works/work-activity";

type NavItem = {
  label: string;
  icon: LucideIcon;
} & (
  | { panel: PanelKey; sub?: string }
  | { route: "takvim" | "integrations" | "ads" | "site" }
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

// With modules on (MODULES_UI) "Ads Manager" is the module in the Modules
// group, so the ads page Explore opens is named for what it is: the ad
// account's campaigns, ad sets and ads. Its own icon too: the megaphone is the
// module's there.
const EXPLORE_WITH_MODULES: NavItem[][] = EXPLORE.map((group) =>
  group.map((item) =>
    "route" in item && item.route === "ads"
      ? { ...item, label: "Ads account", icon: CircleDollarSign }
      : item,
  ),
);

// GA_WEBSITE_PAGE: the Google Analytics "Website" page sits next to the ads
// page, before Connectors.
const WEBSITE_ITEM: NavItem = { label: "Website", icon: Globe, route: "site" };

function withWebsite(groups: NavItem[][]): NavItem[][] {
  return groups.map((group, index) =>
    index === 0
      ? group.flatMap((item) =>
          "route" in item && item.route === "integrations"
            ? [WEBSITE_ITEM, item]
            : [item],
        )
      : group,
  );
}

export function exploreGroups(
  modulesUi: boolean,
  websitePage = false,
): NavItem[][] {
  const groups = modulesUi ? EXPLORE_WITH_MODULES : EXPLORE;
  return websitePage ? withWebsite(groups) : groups;
}

export const MODULES_COPY = { heading: "Modules", soon: "Soon" } as const;

// What a module's line does, like its launcher tile (module-launcher.tsx): a
// ready module opens a new chat for it (the opener reads `?module=`,
// new-work-opener.tsx); Ads Manager opens the Ads account page until its module
// ships; any other module that is not ready says "Soon" and goes nowhere.
export type ModuleLineTarget =
  | { kind: "start"; href: string }
  | { kind: "page"; href: string }
  | { kind: "soon" };

export function moduleLineTarget(
  projectId: string,
  def: ModuleDef,
): ModuleLineTarget {
  if (def.ready) {
    return { kind: "start", href: `/projects/${projectId}?module=${def.key}` };
  }
  if (def.key === "ads") {
    return { kind: "page", href: `/projects/${projectId}/ads` };
  }
  return { kind: "soon" };
}

// The module line marked as open: the module of the chat on screen while that
// chat is still empty (page.tsx passes it only then), for a module whose line
// starts a chat (moduleLineTarget), until its first message makes the chat a
// Recents row, the open line from then on (work-list.tsx).
export function openModuleLine(input: {
  module: ModuleKey | null | undefined;
  // The chat screen: the project root with no panel or record open.
  onChat: boolean;
  // A message was sent in the chat on screen (work-activity.ts).
  sent: boolean;
}): ModuleKey | null {
  const { module } = input;
  if (!module || !input.onChat || input.sent) return null;
  return MODULES[module].ready ? module : null;
}

// The chat a message was last sent in, from the chat screen's announcement
// (work-activity.ts).
function useSentWorkId(projectId: string | undefined): string | null {
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return undefined;
    const onSent = (event: Event) => {
      const activity = activityOf(projectId, (event as CustomEvent).detail);
      if (activity) setSent(activity.workId);
    };
    window.addEventListener(WORK_ACTIVITY_EVENT, onSent);
    return () => window.removeEventListener(WORK_ACTIVITY_EVENT, onSent);
  }, [projectId]);
  return sent;
}

const BADGE_CLASS =
  "flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-semibold tabular-nums text-warning";

// "Soon" on a module that is not ready yet: quiet, not a call to act.
const SOON_CLASS =
  "shrink-0 rounded-full bg-sidebar-accent px-1.5 text-[10px] leading-4 font-medium text-sidebar-foreground/55";

// The project is picked in the sidebar's brand switcher
// (workspace-sidebar.tsx), and this lists the selected project's nav links.
export function SidebarNav({
  activeProjectId,
  toolBadges = {},
  works,
  openWorkUntouched = false,
  openWorkModule = null,
  websitePage = false,
}: {
  activeProjectId?: string;
  toolBadges?: Partial<Record<PanelKey, number>>;
  // Recents (docs/works.md) and, with MODULES_UI, the Modules group. Absent
  // when Works is off: the nav renders exactly as before.
  works?: SidebarWorks;
  // Works: the chat on screen is still the new chat (see AppShell).
  openWorkUntouched?: boolean;
  // Modules: that new chat's module (see AppShell); null: a general chat.
  openWorkModule?: ModuleKey | null;
  // GA_WEBSITE_PAGE: Explore lists the "Website" page.
  websitePage?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The docked sidebar collapsed to its icon rail (sidebar-collapse.tsx):
  // icons only, labels in tooltips, no Recents.
  const rail = useSidebarCollapsed();
  const sentWorkId = useSentWorkId(activeProjectId);
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

  const modulesUi = works?.modulesUi === true;
  // A new chat for a module is that module's, not New Chat's: its line is
  // marked and New Chat stays clickable, back to a general chat.
  const chatModule = modulesUi ? openWorkModule : null;
  const openWorkId = searchParams.get("work");
  const markedModule = openModuleLine({
    module: chatModule,
    onChat: isPlainChat,
    sent: sentWorkId !== null && sentWorkId === openWorkId,
  });
  const primary = PRIMARY.filter((item) => !(works && "home" in item));
  const explore = exploreGroups(modulesUi, websitePage).map((group) =>
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
        works={works.recents}
        openWorkUntouched={openWorkUntouched && !chatModule}
        top={
          modulesUi ? (
            <>
              <ModulesGroup
                projectId={activeProjectId}
                rail={rail}
                current={markedModule}
              />
              {items}
            </>
          ) : (
            items
          )
        }
      />
    </nav>
  );
}

// The modules (src/lib/modules) right under New Chat, one line each. A line
// starts a chat for its module rather than opening a page; while that chat is
// still empty, its line is the marked one (`current`, openModuleLine). Not
// ready yet: a quiet "Soon", and the line goes nowhere (Ads Manager excepted,
// see moduleLineTarget).
function ModulesGroup({
  projectId,
  rail,
  current,
}: {
  projectId: string;
  rail: boolean;
  current: ModuleKey | null;
}) {
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={rail ? undefined : headingId}
      aria-label={rail ? MODULES_COPY.heading : undefined}
      className={cn("space-y-0.5", rail ? "py-2" : "py-3")}
    >
      {rail ? null : (
        <div id={headingId} className={SIDEBAR_HEADING_CLASS}>
          {MODULES_COPY.heading}
        </div>
      )}
      {MODULE_KEYS.map((key) => (
        <ModuleLine
          key={key}
          def={MODULES[key]}
          target={moduleLineTarget(projectId, MODULES[key])}
          rail={rail}
          current={key === current}
        />
      ))}
    </div>
  );
}

function ModuleLine({
  def,
  target,
  rail,
  current,
}: {
  def: ModuleDef;
  target: ModuleLineTarget;
  rail: boolean;
  // Its empty chat is the one on screen (ModulesGroup).
  current: boolean;
}) {
  const soon = target.kind === "soon";
  // The rail shows the icon alone: this is its name and its tooltip.
  const name = soon ? `${def.label} · ${MODULES_COPY.soon}` : def.label;
  const content = (
    <>
      <ModuleIcon module={def.key} className="size-4 shrink-0 opacity-80" />
      {rail ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{def.label}</span>
          {soon ? (
            <span className={SOON_CLASS}>{MODULES_COPY.soon}</span>
          ) : null}
          {/* Opens a page, not a chat (the launcher's "Open Ads account"). */}
          {target.kind === "page" ? (
            <ArrowUpRight
              aria-hidden="true"
              className="size-3.5 shrink-0 opacity-45"
            />
          ) : null}
        </>
      )}
    </>
  );
  const base = rail ? SIDEBAR_RAIL_ITEM_CLASS : SIDEBAR_ITEM_CLASS;
  return (
    <RailTip label={name}>
      {target.kind !== "soon" ? (
        <Link
          href={target.href}
          aria-label={rail ? name : undefined}
          aria-current={current ? "page" : undefined}
          className={cn(
            base,
            current ? SIDEBAR_ACTIVE_CLASS : "hover:bg-sidebar-accent/60",
          )}
        >
          {content}
        </Link>
      ) : (
        // A disabled link: announced as unavailable, not focusable, yet it
        // still gets hover, so the rail's tooltip says what it is.
        <span
          role="link"
          aria-disabled="true"
          aria-label={rail ? name : undefined}
          className={cn(base, "cursor-default text-sidebar-foreground/45")}
        >
          {content}
        </span>
      )}
    </RailTip>
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
