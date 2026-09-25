import Link from "next/link";
import { Sliders, Sparkle } from "lucide-react";

import { buildHubHref } from "@/components/hub-core/hub-core-params";
import type { WorkspaceAutopilotMode } from "./workspace-right-panel-data";

const AUTOPILOT_NOTE: Record<WorkspaceAutopilotMode, string> = {
  REVIEW_EVERYTHING:
    "You approve everything — nothing is planned automatically.",
  CREATE_AUTOMATICALLY: "We plan together, you approve.",
  AUTOPILOT: "Creates, plans, and publishes automatically within your limits.",
};

// Shown at the bottom of all four right-panel tabs — deliberately reads
// the SAME AutonomyPolicy.autopilotMode every tab shares
// (workspace-right-panel-data.ts), not a per-tab duplicate, and links into
// the one real settings screen that controls it.
export function AutopilotCard({
  projectId,
  autopilotMode,
}: {
  projectId: string;
  autopilotMode: WorkspaceAutopilotMode;
}) {
  return (
    <Link
      href={buildHubHref(projectId, { panel: "settings", sub: "autonomy" })}
      scroll={false}
      className="mt-1 flex items-center gap-2.5 rounded-2xl p-3 transition-colors hover:bg-[var(--ws-hover)]"
      style={{ background: "var(--ws-surface-2)" }}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
        style={{ background: "var(--ws-surface)", color: "var(--ws-text)" }}
      >
        <Sparkle className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          Autopilot
        </div>
        <div
          className="truncate text-[11px]"
          style={{ color: "var(--ws-text-2)" }}
        >
          {AUTOPILOT_NOTE[autopilotMode]}
        </div>
      </div>
      <Sliders
        className="size-4 shrink-0"
        style={{ color: "var(--ws-text-2)" }}
      />
    </Link>
  );
}
