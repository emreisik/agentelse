import Link from "next/link";
import {
  ClipboardCheck,
  Gem,
  LayoutGrid,
  Library,
  Lightbulb,
  ListChecks,
  Plug,
  Radio,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Target,
  UserRoundCog,
  Users2,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildHubHref, type PanelKey } from "./hub-core-params";
import { PANEL_LABEL } from "./lineage-map";

const GROUPS: Array<{
  title: string;
  items: Array<{ panel: PanelKey; icon: LucideIcon }>;
}> = [
  {
    title: "System",
    items: [
      { panel: "setup", icon: SlidersHorizontal },
      { panel: "library", icon: Library },
      { panel: "departments", icon: Users2 },
      { panel: "settings", icon: Settings2 },
    ],
  },
  {
    title: "Insight Chain",
    items: [
      { panel: "brand-brain", icon: Gem },
      { panel: "signals", icon: Radio },
      { panel: "insights-opportunities", icon: Lightbulb },
      { panel: "goals", icon: Target },
    ],
  },
  {
    title: "Production",
    items: [
      { panel: "ideas", icon: Sparkles },
      { panel: "work", icon: ListChecks },
      { panel: "approvals", icon: ClipboardCheck },
      { panel: "human-action", icon: UserRoundCog },
    ],
  },
];

// Used to be a "Dashboard" grid dedicated to the project root
// (dashboard-overview.tsx) — since the project root is now directly the
// chat, this was moved into a compact dropdown menu accessible from every
// page within the project.
export function ProjectToolsMenu({
  projectId,
  badges,
}: {
  projectId: string;
  badges: Partial<Record<PanelKey, number>>;
}) {
  const hasAttention = Object.values(badges).some((count) => (count ?? 0) > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="relative gap-1.5 text-muted-foreground"
          />
        }
      >
        <LayoutGrid className="size-4" />
        Tools
        {hasAttention ? (
          <span className="absolute top-1 right-1.5 size-1.5 rounded-full bg-warning" />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
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
            render={<Link href={`/projects/${projectId}/integrations`} />}
          >
            <Plug className="size-4 text-muted-foreground" />
            Integrations
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
