"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ClipboardList,
  Gem,
  Library,
  Lightbulb,
  ListChecks,
  MessageSquarePlus,
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
};

const FLOW_ICON = {
  idea: Lightbulb,
  workPlan: ClipboardList,
  task: ListChecks,
};

// ChatGPT'nin sohbet geçmişi mantığı: üstte kompakt bir proje seçici
// (ProjectSelect), altında seçili projenin "akışları" — her biri bir
// fikrin/iş kaleminin baştan sona hikayesi, tek tek sohbet girişleri
// olarak listeleniyor. Birine tıklamak o akışın tüm geçmişini sohbet
// baloncukları halinde açar (bkz. /projects/[projectId]/page.tsx +
// project-flow-view.tsx). "Yeni sohbet" projenin serbest-metin ajans
// sohbetine (mevcut ProjectChat) götürür.
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
            Yeni sohbet
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "marka-beyni" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "marka-beyni"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Gem className="size-4 shrink-0 opacity-80" />
            Marka Beyni
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "fikirler" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "fikirler"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Sparkles className="size-4 shrink-0 opacity-80" />
            Fikirler
          </Link>

          <Link
            href={buildHubHref(activeProjectId, {
              panel: "isler",
              sub: "gorevler",
            })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "isler"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <ListChecks className="size-4 shrink-0 opacity-80" />
            İşler
          </Link>

          <Link
            href={buildHubHref(activeProjectId, { panel: "kutuphane" })}
            scroll={false}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
              activePanel === "kutuphane"
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60",
            )}
          >
            <Library className="size-4 shrink-0 opacity-80" />
            Kütüphane
          </Link>

          {flows && flows.length > 0 ? (
            <Collapsible
              open={flowsOpen}
              onOpenChange={setFlowsOpen}
              className="pt-2"
            >
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground/70 uppercase transition-colors hover:text-muted-foreground">
                Sohbetler
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
                  const active = activeEntity === `${flow.kind}:${flow.id}`;
                  return (
                    <Link
                      key={`${flow.kind}-${flow.id}`}
                      href={`/projects/${activeProjectId}?entity=${flow.kind}:${flow.id}`}
                      scroll={false}
                      className={cn(
                        "group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sidebar-foreground transition-colors",
                        active
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "hover:bg-sidebar-accent/60",
                      )}
                    >
                      <Icon className="size-4 shrink-0 opacity-70" />
                      <MarqueeText className="flex-1">{flow.title}</MarqueeText>
                    </Link>
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
