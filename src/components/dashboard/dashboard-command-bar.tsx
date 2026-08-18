"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ClipboardCheck,
  FolderKanban,
  HeartPulse,
  Plus,
  Search,
  UserRoundCog,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { cn, statusBadgeVariant } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const PROJECT_STATUS_LABELS: Record<string, string> = {
  CREATED: "Created",
  DISCOVERY: "Discovery",
  NEEDS_INFORMATION: "Needs Information",
  PROFILE_REVIEW: "Profile Review",
  NEEDS_ASSESSMENT: "Needs Assessment",
  STRATEGY: "Strategy",
  ACTIVE: "Active",
  PAUSED: "Paused",
  CLOSED: "Closed",
};

type ProjectItem = { id: string; name: string; status: string };

// The large, ChatGPT-style "search/command" bar on the dashboard — clicking
// it opens a cmdk-based command palette: search across projects or jump
// with one keystroke to frequently used actions (new project, approvals,
// human actions, system health). Also opens with Cmd/Ctrl+K.
export function DashboardCommandBar({ projects }: { projects: ProjectItem[] }) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-5 text-left shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-muted/30 dark:shadow-none",
        )}
      >
        <Search className="size-4.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm text-muted-foreground">
          Search a project or run an action…
        </span>
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search a project or choose an action"
      >
        <CommandInput placeholder="Search a project or type an action…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {projects.length > 0 ? (
            <CommandGroup heading="Projects">
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.name}
                  onSelect={() => go(`/projects/${project.id}`)}
                >
                  <FolderKanban className="text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                  <Badge
                    variant={statusBadgeVariant(project.status)}
                    className="ml-auto text-[10px]"
                  >
                    {PROJECT_STATUS_LABELS[project.status] ?? project.status}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Quick actions">
            <CommandItem
              value="new project"
              onSelect={() => go("/projects/new")}
            >
              <Plus className="text-muted-foreground" />
              Create new project
            </CommandItem>
            <CommandItem value="approvals" onSelect={() => go("/approvals")}>
              <ClipboardCheck className="text-muted-foreground" />
              View approvals
              <CommandShortcut>Approvals</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="human actions"
              onSelect={() => go("/human-actions")}
            >
              <UserRoundCog className="text-muted-foreground" />
              View human actions
            </CommandItem>
            <CommandItem value="system health" onSelect={() => go("/health")}>
              <HeartPulse className="text-muted-foreground" />
              View system health
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
