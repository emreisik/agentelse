"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ChevronsUpDown,
  LogOut,
  Menu,
  Moon,
  PanelRight,
  Sun,
  UserRound,
} from "lucide-react";

import { signOutAction } from "@/server/actions/auth-actions";
import { BrandSwitcher } from "@/components/layout/brand-switcher";
import { SetupProgressBadge } from "@/components/layout/setup-progress-badge";
import { ActiveWorkPopover } from "@/components/layout/active-work-popover";
import { useWorkspacePanelToggle } from "@/components/workspace/workspace-panel-toggle";
import {
  SidebarToggleButton,
  useSidebarCollapsed,
} from "@/components/layout/sidebar-collapse";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
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

// The page has no top bar: what it used to carry lives in the left sidebar
// (app-shell.tsx), kept to ChatGPT's few parts. SidebarTop is the logo, the
// sidebar's own toggle and the brand card (the brand switcher with the
// agency's live count beside it); SidebarBottom is the account row. The right
// panel opens and closes from its own edge (workspace-right-panel.tsx). Below
// md the sidebar is a drawer (MobileSidebar) behind a slim bar. The docked one
// collapses to a 56px icon rail (sidebar-collapse.tsx), where each part
// renders its compact form.

export function SidebarTop({
  projectId,
  projects,
  setupPercent,
  setupStageLabel,
  agencyStatus,
}: {
  projectId?: string;
  projects: { id: string; name: string; status: string }[];
  // null once setup has activated (or never started) — see
  // ProjectNavBadges.setupPercent/setupStageLabel in app-shell.tsx.
  setupPercent: number | null;
  setupStageLabel: string | null;
  agencyStatus: AgencyStatusSnapshot | null;
}) {
  const rail = useSidebarCollapsed();

  // The icon rail: the toggle on top, the brand's tile under it. The live
  // count doesn't fit; setup progress still shows as the corner widget.
  if (rail) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 px-2 pt-3 pb-1">
        <SidebarToggleButton />
        <BrandSwitcher
          projects={projects}
          activeProjectId={projectId}
          compact
        />
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-3 px-3 pt-3 pb-1">
      {/* pl-2.5 = SidebarNav's item px-2.5: the logo sits on the nav icons'
          column. */}
      <div className="flex h-9 items-center justify-between gap-1 pl-2.5">
        <Link
          href="/dashboard"
          className="flex shrink-0 items-center transition-opacity hover:opacity-80"
        >
          <img src="/logo.png" alt="Agentelse" className="h-6 object-contain" />
        </Link>
        <SidebarToggleButton />
      </div>
      {/* The brand card: the one bordered block in the sidebar, so the brand
          being worked on stands apart from the navigation under it. */}
      <div
        className="flex min-w-0 items-center gap-0.5 rounded-xl border p-1"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <div className="min-w-0 flex-1">
          <BrandSwitcher projects={projects} activeProjectId={projectId} />
        </div>
        {projectId ? (
          <ActiveWorkPopover
            projectId={projectId}
            initial={agencyStatus}
            compact
          />
        ) : null}
      </div>
      {projectId && setupPercent != null ? (
        <SetupProgressBadge
          projectId={projectId}
          percent={setupPercent}
          stageLabel={setupStageLabel}
        />
      ) : null}
    </div>
  );
}

export function SidebarBottom({
  displayName,
  workspaceName,
  email,
}: {
  displayName: string | null;
  workspaceName: string | null;
  email: string | null;
}) {
  const rail = useSidebarCollapsed();
  return (
    <div
      className={
        rail
          ? "flex shrink-0 justify-center border-t border-sidebar-border px-2 py-2.5"
          : "shrink-0 border-t border-sidebar-border px-3 py-2.5"
      }
    >
      <AccountMenu
        displayName={displayName}
        workspaceName={workspaceName}
        email={email}
        compact={rail}
      />
    </div>
  );
}

// Below md: a slim bar (menu, logo and, on the chat, the right panel's
// toggle: its edge strip is hidden on a phone) and the sidebar in a left
// drawer. `children` is the same sidebar content the docked <aside> shows; the
// drawer closes itself on every navigation.
export function MobileSidebar({
  children,
  hasRightPanel,
}: {
  children: ReactNode;
  hasRightPanel: boolean;
}) {
  // Open "at" the URL it was opened on: any navigation changes the URL, which
  // closes it without an effect.
  const location = `${usePathname()}?${useSearchParams().toString()}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === location;
  const setOpen = (next: boolean) => setOpenAt(next ? location : null);

  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border bg-sidebar px-2 md:hidden">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <Menu className="size-4" />
        </button>
        <Link href="/dashboard" className="flex shrink-0 items-center">
          <img src="/logo.png" alt="Agentelse" className="h-5 object-contain" />
        </Link>
      </div>
      {hasRightPanel ? <PanelToggleButton /> : null}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="gap-0 bg-sidebar p-0 data-[side=left]:w-72 data-[side=left]:max-w-[85vw]"
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    </div>
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

// Profile identity, theme and sign-out behind the account row at the bottom
// of the sidebar; the menu opens upwards (to the right from the rail).
function AccountMenu({
  displayName,
  workspaceName,
  email,
  compact = false,
}: {
  displayName: string | null;
  workspaceName: string | null;
  email: string | null;
  // The rail: the avatar alone.
  compact?: boolean;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [signingOut, startSignOut] = useTransition();
  const dark = resolvedTheme === "dark";
  const itemStyle = { color: "var(--ws-text)" };
  const name = displayName ?? email ?? "Unknown user";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account menu"
            title={compact ? name : undefined}
            className={
              compact
                ? "flex size-10 items-center justify-center rounded-lg transition-colors hover:bg-[var(--ws-hover)]"
                : "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--ws-hover)]"
            }
          />
        }
      >
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {name.charAt(0).toUpperCase()}
        </span>
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span
                className="block truncate text-sm font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {name}
              </span>
              <span
                className="block truncate text-[11px]"
                style={{ color: "var(--ws-text-3)" }}
              >
                {workspaceName ?? email ?? "—"}
              </span>
            </span>
            <ChevronsUpDown
              className="size-3.5 shrink-0"
              style={{ color: "var(--ws-text-3)" }}
            />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={compact ? "right" : "top"}
        align={compact ? "end" : "start"}
        sideOffset={6}
        className="min-w-56 rounded-[14px] border p-2 shadow-lg"
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
              {name}
            </span>
            <span
              className="block truncate text-[11px] font-normal"
              style={{ color: "var(--ws-text-3)" }}
            >
              {email ?? "—"}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator style={{ background: "var(--ws-border)" }} />
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
