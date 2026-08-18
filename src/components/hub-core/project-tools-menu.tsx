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
    title: "Sistem",
    items: [
      { panel: "kurulum", icon: SlidersHorizontal },
      { panel: "kutuphane", icon: Library },
      { panel: "departmanlar", icon: Users2 },
      { panel: "ayarlar", icon: Settings2 },
    ],
  },
  {
    title: "İçgörü Zinciri",
    items: [
      { panel: "marka-beyni", icon: Gem },
      { panel: "sinyaller", icon: Radio },
      { panel: "icgoru-firsat", icon: Lightbulb },
      { panel: "hedefler", icon: Target },
    ],
  },
  {
    title: "Üretim",
    items: [
      { panel: "fikirler", icon: Sparkles },
      { panel: "isler", icon: ListChecks },
      { panel: "onaylar", icon: ClipboardCheck },
      { panel: "insan-eylem", icon: UserRoundCog },
    ],
  },
];

// Eskiden proje köküne özel bir "Dashboard" grid'iydi (dashboard-overview.tsx)
// — proje kökü artık doğrudan sohbet olduğu için bu, tüm proje-içi
// sayfalardan erişilebilen kompakt bir açılır menüye taşındı.
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
        Araçlar
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
            render={<Link href={`/projects/${projectId}/entegrasyonlar`} />}
          >
            <Plug className="size-4 text-muted-foreground" />
            Entegrasyonlar
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
