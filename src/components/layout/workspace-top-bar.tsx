"use client";

import Link from "next/link";
import { PanelRight } from "lucide-react";

import { buildHubHref } from "@/components/hub-core/hub-core-params";
import { BrandSwitcher } from "@/components/layout/brand-switcher";
import { SetupProgressBadge } from "@/components/layout/setup-progress-badge";
import { ActiveWorkPopover } from "@/components/layout/active-work-popover";
import { useWorkspacePanelToggle } from "@/components/workspace/workspace-panel-toggle";
import type { AgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";

// The Brand Workspace root screen's header: 72px, logo tile +
// "agentelse." wordmark + brand switcher on the left, active-work +
// approvals + panel toggle + account avatar on the right, all on
// the --ws-* token set (globals.css, Faz 12: grayscale, aliased to the
// app's own tokens) — light/dark resolve automatically through those
// variables, no dark: pairs needed here. Deliberately a SEPARATE
// component from TopBar.tsx
// (used by every other screen — Ideas/Work/Library/Settings/etc, which
// keep their existing header and existing oklch tokens) rather than a
// giant conditional branch inside it, so this redesign can't regress any
// of those screens.
export function WorkspaceTopBar({
  projectId,
  projectName,
  projects,
  pendingApprovals,
  setupPercent,
  setupStageLabel,
  agencyStatus,
  displayName,
  email,
  showLogo,
}: {
  projectId: string;
  projectName: string;
  projects: { id: string; name: string; status: string }[];
  pendingApprovals: number;
  // null once setup has activated (or never started) — see
  // ProjectNavBadges.setupPercent/setupStageLabel in app-shell.tsx.
  setupPercent: number | null;
  setupStageLabel: string | null;
  agencyStatus: AgencyStatusSnapshot | null;
  displayName: string | null;
  email: string | null;
  // false once the docked SidebarNav (app-shell.tsx) already shows the
  // logo — avoids rendering it twice side by side.
  showLogo: boolean;
}) {
  const { toggle } = useWorkspacePanelToggle();

  return (
    <header
      className="flex h-[72px] shrink-0 items-center justify-between border-b px-4 sm:px-7"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {showLogo ? (
          <>
            <Link
              href="/dashboard"
              className="flex shrink-0 items-center transition-opacity hover:opacity-80"
            >
              <img
                src="/logo.png"
                alt="Agentelse"
                className="h-6 object-contain"
              />
            </Link>
            <div
              className="hidden h-6 w-px shrink-0 sm:block"
              style={{ background: "var(--ws-border)" }}
            />
          </>
        ) : null}
        <BrandSwitcher projects={projects} activeProjectId={projectId} />
        {setupPercent != null ? (
          <SetupProgressBadge
            projectId={projectId}
            percent={setupPercent}
            stageLabel={setupStageLabel}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden md:block">
          <ActiveWorkPopover projectId={projectId} initial={agencyStatus} />
        </div>
        <Link
          href={buildHubHref(projectId, { panel: "approvals" })}
          scroll={false}
          className="hidden h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors hover:opacity-85 sm:flex"
          style={{
            background: "var(--ws-surface-2)",
            color: "var(--ws-accent)",
          }}
          title={`${projectName} — pending approvals`}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: "var(--ws-pending)" }}
          />
          {pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"}
        </Link>
        <div
          className="hidden h-6 w-px shrink-0 sm:block"
          style={{ background: "var(--ws-border)" }}
        />
        <button
          type="button"
          onClick={toggle}
          aria-label="Toggle workspace panel"
          title="Brand / Files / Outputs / Calendar"
          className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <PanelRight className="size-4" />
        </button>
        <Link
          href="/profile"
          title={displayName ?? email ?? undefined}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-opacity hover:opacity-80"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {(displayName ?? email ?? "?").charAt(0).toUpperCase()}
        </Link>
      </div>
    </header>
  );
}
