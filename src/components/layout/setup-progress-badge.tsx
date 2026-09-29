import Link from "next/link";

import { buildHubHref } from "@/components/hub-core/hub-core-params";

const SCAN_GRADIENT =
  "linear-gradient(90deg, var(--special), var(--chart-3), var(--dept-intel), var(--special))";

// Compact companion to the brand switcher in the Brand Workspace top bar —
// replaces the old bottom-right floating SetupProgressWidget (a whole
// separate always-on-top corner element) with something that lives right
// next to the brand it's actually about. `stageLabel` is what the client
// asked to see change — the current stage's name in plain text, stepping
// forward on its own (INTAKE -> Deep Discovery -> Brand Constitution -> ...)
// as setup-progress-view.tsx's underlying stage records advance — not just a
// bare percentage. The color-cycling dot (globals.css's `ai-scan` keyframe,
// the same accents the setup spotlight already uses) is the "still alive"
// cue a static number/label alone wouldn't give. "?panel=setup" is one click
// away for the full picture (stage list, findings, any pending decision).
//
// Same pill weight as ActiveWorkPopover's trigger (border + surface bg +
// shadow, full-contrast label) — first shipped with only hover:bg and
// muted/faint text, which read as an inert label rather than the one thing
// on this screen that still needs the client's attention, easy to miss
// entirely next to the brand switcher.
export function SetupProgressBadge({
  projectId,
  percent,
  stageLabel,
}: {
  projectId: string;
  percent: number;
  stageLabel: string | null;
}) {
  return (
    <Link
      href={buildHubHref(projectId, { panel: "setup" })}
      scroll={false}
      title={`Setting up your agency — ${stageLabel ?? ""} (${percent}%)`}
      // Deliberately NOT shrink-0: beside the brand switcher and the
      // Advanced button it is the item that gives way first (stage label
      // ellipsizes; dot and % stay), instead of crushing the brand name.
      className="flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-full border px-3 text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[var(--ws-hover)]"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        color: "var(--ws-text)",
      }}
    >
      <span className="relative flex size-2.5 shrink-0 overflow-hidden rounded-full">
        <span
          className="absolute inset-0 animate-[ai-scan_2s_linear_infinite] bg-[length:200%_100%]"
          style={{ backgroundImage: SCAN_GRADIENT }}
        />
      </span>
      <span className="max-w-36 truncate">{stageLabel ?? "Setting up"}</span>
      <span
        className="shrink-0 tabular-nums"
        style={{ color: "var(--ws-accent)" }}
      >
        {percent}%
      </span>
    </Link>
  );
}
