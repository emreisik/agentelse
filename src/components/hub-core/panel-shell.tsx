import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { buildHubHref, type EntityRef, type PanelKey } from "./hub-core-params";
import { PANEL_LABEL } from "./lineage-map";
import { HubBreadcrumb } from "./hub-breadcrumb";
import { SetupPanel } from "./panels/setup-panel";
import { LibraryPanel } from "./panels/library-panel";
import { BrandBrainPanel } from "./panels/brand-brain-panel";
import { SignalsPanel } from "./panels/signals-panel";
import { InsightsOpportunitiesPanel } from "./panels/insights-opportunities-panel";
import { GoalsPanel } from "./panels/goals-panel";
import { IdeasPanel } from "./panels/ideas-panel";
import { WorkPanel } from "./panels/work-panel";
import { DepartmentsPanel } from "./panels/departments-panel";
import { HumanActionPanel } from "./panels/human-action-panel";
import { SettingsPanel } from "./panels/settings-panel";
import type { PanelProps } from "./panels/panel-props";

const PANEL_COMPONENT: Record<
  PanelKey,
  (props: PanelProps) => Promise<React.ReactNode>
> = {
  setup: SetupPanel,
  "brand-brain": BrandBrainPanel,
  signals: SignalsPanel,
  "insights-opportunities": InsightsOpportunitiesPanel,
  goals: GoalsPanel,
  ideas: IdeasPanel,
  work: WorkPanel,
  departments: DepartmentsPanel,
  "human-action": HumanActionPanel,
  settings: SettingsPanel,
  library: LibraryPanel,
};

// View dispatched according to the `?panel=&sub=&entity=` contract — no
// longer a modal, now a full-page piece of content that replaces the
// project root (chat) itself (similar to ChatGPT's transition to its
// settings/tools screens: a back link on top, a plain single-column
// content area below). Returns to the project root (chat screen) on
// close.
export async function PanelShell({
  projectId,
  panel,
  sub,
  entity,
}: {
  projectId: string;
  panel: PanelKey | null;
  sub: string | null;
  entity: EntityRef | null;
}) {
  if (!panel) return null;

  const closeHref = buildHubHref(projectId, {
    panel: null,
    sub: null,
    entity: null,
  });
  const Panel = PANEL_COMPONENT[panel];
  // The list (kanban) view of the ideas and work panels uses its own
  // column/card overflow instead of page scrolling — this needs to be
  // distinguished from the normal long-scroll view that's used when an
  // entity detail is open (entity=idea:ID, entity=task:ID, etc). All 4
  // sub-tabs of work (plans/tasks/cycles/measurements) now share the same
  // kanban system (see the *Board functions in work-panel.tsx).
  const isBoard = (panel === "ideas" || panel === "work") && !entity;

  return (
    <div
      className={cn(
        // Fills AppShell's <main> (h-full) — not a viewport calc tied to
        // the header height, which drifted the moment the header changed.
        "h-full",
        isBoard ? "flex flex-col overflow-hidden" : "overflow-y-auto",
      )}
    >
      <div
        className={cn(
          "w-full pt-8",
          isBoard
            ? "flex min-h-0 flex-1 flex-col px-4 pb-6 sm:px-6"
            : "mx-auto max-w-5xl px-6 pb-16",
        )}
      >
        <Link
          href={closeHref}
          scroll={false}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to chat
        </Link>
        {panel !== "work" && (
          <>
            <h1 className="mt-4 shrink-0 font-heading text-2xl font-semibold tracking-tight">
              {PANEL_LABEL[panel]}
            </h1>
            {panel !== "ideas" && (
              <div className="shrink-0">
                <HubBreadcrumb projectId={projectId} panel={panel} />
              </div>
            )}
          </>
        )}
        <div className={cn("mt-6", isBoard && "flex min-h-0 flex-1 flex-col")}>
          <Panel projectId={projectId} entity={entity} sub={sub} />
        </div>
      </div>
    </div>
  );
}
