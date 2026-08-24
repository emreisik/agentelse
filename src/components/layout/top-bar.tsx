"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardCheck,
  HeartPulse,
  LogOut,
  Plus,
  UserRoundCog,
} from "lucide-react";

import { signOutAction } from "@/server/actions/auth-actions";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { ProjectSelect } from "@/components/layout/project-select";
import { ProjectToolsMenu } from "@/components/hub-core/project-tools-menu";
import {
  buildHubHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";
import { cn } from "@/lib/utils";

export function TopBar({
  showLogo,
  projects,
  pendingApprovals,
  pendingHumanActions,
  systemErrors,
  toolBadges,
  displayName,
  workspaceName,
  email,
}: {
  showLogo: boolean;
  projects: { id: string; name: string; status: string }[];
  pendingApprovals: number;
  pendingHumanActions: number;
  systemErrors: number;
  toolBadges: Partial<Record<PanelKey, number>>;
  displayName: string | null;
  workspaceName: string | null;
  email: string | null;
}) {
  const pathname = usePathname();
  const activeProject = projects.find((project) =>
    pathname.startsWith(`/projects/${project.id}`),
  );
  // In a project context, the topbar moves closer to ChatGPT's minimal,
  // borderless top strip — workspace-wide pages keep the existing bordered
  // look. The project list now lives in the sidebar so it isn't repeated
  // here — only the active project's name is shown.
  const minimal = Boolean(activeProject);

  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center justify-between bg-background px-6",
        !minimal && "border-b border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {showLogo ? (
          <Link
            href="/dashboard"
            className="flex shrink-0 items-center transition-opacity hover:opacity-80"
          >
            <img
              src="/logo.png"
              alt="Agentelse"
              className="h-10 w-full object-contain"
            />
          </Link>
        ) : null}
        {activeProject ? (
          <ProjectSelect
            projects={projects}
            activeProjectId={activeProject.id}
          />
        ) : null}
        {activeProject ? (
          <ProjectToolsMenu projectId={activeProject.id} badges={toolBadges} />
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <TopBarAction
          href={
            activeProject
              ? buildHubHref(activeProject.id, { panel: "approvals" })
              : "/approvals"
          }
          icon={ClipboardCheck}
          label="approvals"
          count={activeProject ? (toolBadges.approvals ?? 0) : pendingApprovals}
        />
        <TopBarAction
          href={
            activeProject
              ? buildHubHref(activeProject.id, { panel: "human-action" })
              : "/human-actions"
          }
          icon={UserRoundCog}
          label="actions"
          count={
            activeProject
              ? (toolBadges["human-action"] ?? 0)
              : pendingHumanActions
          }
        />
        <TopBarAction
          href="/health"
          icon={HeartPulse}
          label="errors"
          count={systemErrors}
        />
        <Button
          render={<Link href="/projects/new" />}
          nativeButton={false}
          size="sm"
          className="ml-1 gap-1.5"
        >
          <Plus className="size-4" />
          New project
        </Button>

        <div className="ml-2 flex items-center gap-2 border-l border-border pl-3">
          <Link
            href="/profile"
            className="flex min-w-0 items-center gap-2 rounded-md transition-opacity hover:opacity-80"
            title="Profile settings"
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
              title={displayName ?? email ?? undefined}
            >
              {(displayName ?? email ?? "?").charAt(0).toUpperCase()}
            </span>
            <div className="hidden min-w-0 leading-tight sm:block">
              <div className="max-w-32 truncate text-xs font-medium">
                {displayName ?? "Unknown user"}
              </div>
              <div className="max-w-32 truncate text-[11px] text-muted-foreground">
                {workspaceName ?? "—"}
              </div>
            </div>
          </Link>
          <ThemeToggle />
          <form action={signOutAction}>
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              title="Sign out"
            >
              <LogOut />
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

// IDENTICAL look whether inside a project (the minimal topbar above) or on
// non-project (workspace-wide) pages: icon + count + label text, a plain
// ghost button — no separate style for the two contexts.
function TopBarAction({
  href,
  icon: Icon,
  label,
  count,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <Button
      render={<Link href={href} />}
      nativeButton={false}
      variant="ghost"
      size="sm"
      className="gap-1.5 text-muted-foreground"
    >
      <Icon className="size-4" />
      {count} {label}
    </Button>
  );
}
