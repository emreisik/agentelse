"use client";

import { useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  ClipboardCheck,
  HeartPulse,
  LogOut,
  Moon,
  PanelRight,
  Plus,
  Sun,
  UserRound,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";

import { signOutAction } from "@/server/actions/auth-actions";
import {
  buildHubHref,
  decisionsHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";
import { ProjectToolsMenu } from "@/components/hub-core/project-tools-menu";
import { BrandSwitcher } from "@/components/layout/brand-switcher";
import { SetupProgressBadge } from "@/components/layout/setup-progress-badge";
import { OpenAiCreditPill } from "@/components/layout/openai-credit-pill";
import type { OpenAiCredit } from "@/server/billing/openai-credit";
import { ActiveWorkPopover } from "@/components/layout/active-work-popover";
import { useWorkspacePanelToggle } from "@/components/workspace/workspace-panel-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";

export type HeaderCounts = {
  approvals: number;
  humanActions: number;
  errors: number;
};

// Tailwind's `lg` — the header's counters and "+" button only fit from here
// up (the docked 256px sidebar eats into the width), below it they move into
// the account menu instead of disappearing. In rem, exactly like Tailwind v4's
// `--breakpoint-lg: 64rem`: a px value here drifts from the `lg:` classes
// whenever the browser's default font size isn't 16px, hiding the counters
// in CSS while the menu fallback (gated on this query) stays hidden too.
const WIDE_QUERY = "(min-width: 64rem)";

function useIsWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(WIDE_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The ONE header of every signed-in page (app-shell.tsx renders it for the
// project chat, its ?panel= hub panels, project sub-pages and workspace-wide
// pages alike): 72px, --ws-* tokens (globals.css — grayscale, aliased to the
// app's own tokens, so light/dark resolve without dark: pairs). Carries
// everything the retired TopBar had — brand switcher, Advanced tools,
// agency status, approvals / human actions / errors, New project, profile,
// theme, sign out. Project-only pieces render only when projectId is set.
export function WorkspaceTopBar({
  projectId,
  projectName,
  projects,
  counts,
  toolBadges,
  setupPercent,
  setupStageLabel,
  agencyStatus,
  displayName,
  workspaceName,
  email,
  showLogo,
  hasRightPanel,
  openaiCredit,
}: {
  projectId?: string;
  projectName: string;
  projects: { id: string; name: string; status: string }[];
  // Project-scoped inside a project, workspace-wide elsewhere — resolved in
  // app-shell.tsx, the same split the old TopBar made.
  counts: HeaderCounts;
  toolBadges: Partial<Record<PanelKey, number>>;
  // null once setup has activated (or never started) — see
  // ProjectNavBadges.setupPercent/setupStageLabel in app-shell.tsx.
  setupPercent: number | null;
  setupStageLabel: string | null;
  agencyStatus: AgencyStatusSnapshot | null;
  displayName: string | null;
  workspaceName: string | null;
  email: string | null;
  // false once the docked SidebarNav (app-shell.tsx) already shows the
  // logo — avoids rendering it twice side by side.
  showLogo: boolean;
  // Only the project chat root has the Brand/Files/Outputs/Calendar panel
  // (and its toggle context) — elsewhere the toggle would be a dead button.
  hasRightPanel: boolean;
  openaiCredit: OpenAiCredit | null;
}) {
  // Decisions live on the Agency Desk (pending cards in the chat) — workspace-wide
  // pages land on the dashboard's per-project "needs you" queue instead.
  const approvalsHref = projectId ? decisionsHref(projectId) : "/dashboard";
  const humanActionsHref = projectId
    ? buildHubHref(projectId, { panel: "human-action" })
    : "/human-actions";

  return (
    <header
      className="flex h-[72px] shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-7"
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
        {projectId && setupPercent != null ? (
          <SetupProgressBadge
            projectId={projectId}
            percent={setupPercent}
            stageLabel={setupStageLabel}
          />
        ) : null}
        {projectId ? (
          <ProjectToolsMenu projectId={projectId} badges={toolBadges} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Below md the docked sidebar leaves no room for the pill — it
            would push the avatar off-screen, the only way to sign out. The
            popover content is portaled, so this wrapper doesn't affect it. */}
        {projectId ? (
          <div className="hidden md:block">
            <ActiveWorkPopover projectId={projectId} initial={agencyStatus} />
          </div>
        ) : null}
        {openaiCredit ? <OpenAiCreditPill initial={openaiCredit} /> : null}
        <div className="hidden items-center gap-0.5 lg:flex">
          <HeaderCount
            href={approvalsHref}
            icon={ClipboardCheck}
            count={counts.approvals}
            one="decision"
            many="decisions"
            title={
              projectId
                ? `${projectName} — ${plural(counts.approvals, "decision waiting", "decisions waiting")}`
                : plural(
                    counts.approvals,
                    "decision waiting",
                    "decisions waiting",
                  )
            }
            attention={counts.approvals > 0 ? "pending" : null}
          />
          <HeaderCount
            href={humanActionsHref}
            icon={UserRoundCog}
            count={counts.humanActions}
            one="action"
            many="actions"
            title={plural(
              counts.humanActions,
              "action waiting on you",
              "actions waiting on you",
            )}
            attention={counts.humanActions > 0 ? "pending" : null}
          />
          <HeaderCount
            href="/health"
            icon={HeartPulse}
            count={counts.errors}
            one="error"
            many="errors"
            title={plural(
              counts.errors,
              "open system error",
              "open system errors",
            )}
            attention={counts.errors > 0 ? "danger" : null}
          />
        </div>
        <Link
          href="/projects/new"
          title="New project"
          aria-label="New project"
          className="hidden size-8 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-[var(--ws-hover)] lg:flex"
          style={{
            borderColor: "var(--ws-border)",
            color: "var(--ws-text)",
          }}
        >
          <Plus className="size-4" />
        </Link>
        <div
          className="hidden h-6 w-px shrink-0 sm:block"
          style={{ background: "var(--ws-border)" }}
        />
        {hasRightPanel ? <PanelToggleButton /> : null}
        <AccountMenu
          displayName={displayName}
          workspaceName={workspaceName}
          email={email}
          counts={counts}
          approvalsHref={approvalsHref}
          humanActionsHref={humanActionsHref}
        />
      </div>
    </header>
  );
}

// Icon + count always, the word only from 2xl up (xl is a 1280px viewport,
// but with the docked sidebar the header is only 1024px wide there — the
// words made it overflow); a status dot when the number needs attention
// (color reserved for real state, as elsewhere). aria-label because the
// hidden word would otherwise leave screen readers with just "3, link".
function HeaderCount({
  href,
  icon: Icon,
  count,
  one,
  many,
  title,
  attention,
}: {
  href: string;
  icon: LucideIcon;
  count: number;
  one: string;
  many: string;
  title: string;
  attention: "pending" | "danger" | null;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium tabular-nums whitespace-nowrap transition-colors hover:bg-[var(--ws-hover)]"
      style={{ color: count > 0 ? "var(--ws-text)" : "var(--ws-text-3)" }}
    >
      {attention ? (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{
            background:
              attention === "danger"
                ? "var(--destructive)"
                : "var(--ws-pending)",
          }}
        />
      ) : null}
      <Icon className="size-4 shrink-0" />
      {count}
      <span className="hidden 2xl:inline">{count === 1 ? one : many}</span>
    </Link>
  );
}

// Split out so useWorkspacePanelToggle (which throws outside its provider)
// is only ever called where app-shell.tsx actually mounts the provider.
function PanelToggleButton() {
  const { toggle } = useWorkspacePanelToggle();
  return (
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
  );
}

// Profile identity, theme and sign-out behind the avatar — plus, below lg,
// the counters and New project the header itself has no room for.
function AccountMenu({
  displayName,
  workspaceName,
  email,
  counts,
  approvalsHref,
  humanActionsHref,
}: {
  displayName: string | null;
  workspaceName: string | null;
  email: string | null;
  counts: HeaderCounts;
  approvalsHref: string;
  humanActionsHref: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const isWide = useIsWide();
  const [signingOut, startSignOut] = useTransition();
  const dark = resolvedTheme === "dark";
  const itemStyle = { color: "var(--ws-text)" };
  const waiting = counts.approvals + counts.humanActions + counts.errors;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={
              waiting > 0
                ? `Account menu, ${waiting} waiting on you`
                : "Account menu"
            }
            title={displayName ?? email ?? undefined}
            className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-opacity hover:opacity-80"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
          />
        }
      >
        {(displayName ?? email ?? "?").charAt(0).toUpperCase()}
        {/* Below lg the counters live inside this menu, so it carries the
            attention signal they'd otherwise give. CSS-hidden (not gated on
            useIsWide) so server and client render the same markup. */}
        {waiting > 0 ? (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full lg:hidden"
            style={{
              background:
                counts.errors > 0 ? "var(--destructive)" : "var(--ws-pending)",
              boxShadow: "0 0 0 2px var(--ws-surface)",
            }}
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 rounded-[14px] border p-2 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1 pb-2">
            <span
              className="block truncate text-sm font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {displayName ?? "Unknown user"}
            </span>
            <span
              className="block truncate text-[11px] font-normal"
              style={{ color: "var(--ws-text-3)" }}
            >
              {workspaceName ?? email ?? "—"}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator style={{ background: "var(--ws-border)" }} />
        {isWide ? null : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem
                render={<Link href={approvalsHref} />}
                style={itemStyle}
              >
                <ClipboardCheck />
                {plural(counts.approvals, "decision", "decisions")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href={humanActionsHref} />}
                style={itemStyle}
              >
                <UserRoundCog />
                {plural(counts.humanActions, "action", "actions")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href="/health" />}
                style={itemStyle}
              >
                <HeartPulse />
                {plural(counts.errors, "error", "errors")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href="/projects/new" />}
                style={itemStyle}
              >
                <Plus />
                New project
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator style={{ background: "var(--ws-border)" }} />
          </>
        )}
        <DropdownMenuItem render={<Link href="/profile" />} style={itemStyle}>
          <UserRound />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme(dark ? "light" : "dark")}
          style={itemStyle}
        >
          {dark ? <Sun /> : <Moon />}
          {dark ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        <DropdownMenuSeparator style={{ background: "var(--ws-border)" }} />
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          onClick={() =>
            startSignOut(async () => {
              await signOutAction();
            })
          }
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
