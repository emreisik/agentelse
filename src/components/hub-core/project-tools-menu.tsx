import Link from "next/link";
import {
  CalendarDays,
  Compass,
  Lightbulb,
  Megaphone,
  Plug,
  Radio,
  Settings2,
  SlidersHorizontal,
  Target,
  UserRoundCog,
  Users2,
  type LucideIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ADVANCED_PANEL_KEYS,
  buildHubHref,
  type PanelKey,
} from "./hub-core-params";
import { PANEL_LABEL } from "./lineage-map";

const PANEL_ICON: Record<(typeof ADVANCED_PANEL_KEYS)[number], LucideIcon> = {
  setup: SlidersHorizontal,
  departments: Users2,
  "human-action": UserRoundCog,
  settings: Settings2,
  signals: Radio,
  "insights-opportunities": Lightbulb,
  goals: Target,
};

const GROUPS: Array<{
  title: string;
  items: Array<{ panel: PanelKey; icon: LucideIcon }>;
}> = [
  {
    title: "System",
    items: [
      { panel: "setup", icon: PANEL_ICON.setup },
      { panel: "departments", icon: PANEL_ICON.departments },
      { panel: "human-action", icon: PANEL_ICON["human-action"] },
      { panel: "settings", icon: PANEL_ICON.settings },
    ],
  },
  {
    title: "Insight Chain",
    items: [
      { panel: "signals", icon: PANEL_ICON.signals },
      {
        panel: "insights-opportunities",
        icon: PANEL_ICON["insights-opportunities"],
      },
      { panel: "goals", icon: PANEL_ICON.goals },
    ],
  },
];

// Everything here already has a dedicated sidebar entry (Brand Brain, Ideas,
// Work, Library) — this menu exists only for ADVANCED_PANEL_KEYS, the panels
// with no primary entry of their own. Keep the two lists in sync: adding a
// panel here without also listing it in ADVANCED_PANEL_KEYS
// (hub-core-params.ts) is a mistake.
export function ProjectToolsMenu({
  projectId,
  badges,
}: {
  projectId: string;
  badges: Partial<Record<PanelKey, number>>;
}) {
  // Only the panels this menu actually lists — `badges` also carries keys
  // (work...) with their own sidebar entry, and a dot for those would point
  // at nothing inside this menu.
  const hasAttention = GROUPS.some((group) =>
    group.items.some((item) => (badges[item.panel] ?? 0) > 0),
  );

  // Header (workspace-top-bar.tsx) trigger in the --ws-* pill language; the
  // label collapses to the icon below 2xl so the header never overflows (xl
  // is a 1280px viewport, but with the docked sidebar the header is only
  // 1024px wide there), the title keeps it discoverable.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="Advanced"
            className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          />
        }
      >
        <Compass className="size-4" />
        <span className="hidden 2xl:inline">Advanced</span>
        {hasAttention ? (
          <span
            className="absolute top-1 right-1 size-1.5 rounded-full"
            style={{ background: "var(--ws-pending)" }}
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 rounded-[14px] border p-2 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        {GROUPS.map((group, index) => (
          <div key={group.title}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
              {group.items.map((item) => {
                const Icon = item.icon;
                const count = badges[item.panel];
                return (
                  <DropdownMenuItem
                    key={item.panel}
                    render={
                      <Link
                        href={buildHubHref(projectId, {
                          panel: item.panel,
                          sub: null,
                          entity: null,
                        })}
                        scroll={false}
                      />
                    }
                    className="justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" />
                      {PANEL_LABEL[item.panel]}
                    </span>
                    {count ? (
                      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-semibold tabular-nums text-warning">
                        {count}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            render={<Link href={`/projects/${projectId}/takvim`} />}
          >
            <CalendarDays className="size-4 text-muted-foreground" />
            Content Calendar
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href={`/projects/${projectId}/ads`} />}
          >
            <Megaphone className="size-4 text-muted-foreground" />
            Ads Manager
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href={`/projects/${projectId}/integrations`} />}
          >
            <Plug className="size-4 text-muted-foreground" />
            Connectors
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
