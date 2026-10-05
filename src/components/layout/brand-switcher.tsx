"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The sidebar's brand switcher (projects -> /projects/{id}) — grouped label,
// serif-letter avatar rows, active-brand check and a trailing "Add brand"
// row, which a plain <Select> list couldn't express.
// --ws-* tokens throughout (globals.css, grayscale, aliased to the app's
// own tokens) — no per-brand color. Built on the same
// base-ui DropdownMenu primitive as the rest of the app (focus trap,
// outside-click, Escape) rather than a hand-rolled popover.
function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[8px] font-serif"
      style={{
        width: size,
        height: size,
        background: "var(--ws-surface-2)",
        color: "var(--ws-text)",
        fontSize: size * 0.5,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function BrandSwitcher({
  projects,
  activeProjectId,
  compact = false,
}: {
  projects: { id: string; name: string; status: string }[];
  // Undefined on workspace-wide pages (dashboard, approvals, health...) —
  // the trigger then reads "Select brand" and the list works as a jump-in.
  activeProjectId?: string;
  // The collapsed sidebar's icon rail: the brand's letter tile alone; the
  // list opens to the right.
  compact?: boolean;
}) {
  const router = useRouter();
  const active = projects.find((p) => p.id === activeProjectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            // The sidebar's full width; the name truncates, the chevron stays
            // on the right edge.
            className={cn(
              "flex items-center rounded-lg transition-colors hover:bg-[var(--ws-hover)]",
              compact
                ? "size-10 justify-center"
                : "w-full min-w-0 gap-2 px-2 py-1.5",
            )}
            aria-label={
              compact ? `Brand: ${active?.name ?? "select brand"}` : undefined
            }
            title={compact ? (active?.name ?? "Select brand") : undefined}
          />
        }
      >
        {active ? (
          <Avatar name={active.name} size={28} />
        ) : compact ? (
          <ChevronDown
            className="size-4"
            style={{ color: "var(--ws-text-2)" }}
          />
        ) : null}
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 text-left leading-tight">
              <span
                className="block truncate text-sm font-semibold"
                style={{ color: "var(--ws-text)" }}
              >
                {active?.name ?? "Select brand"}
              </span>
              <span
                className="block truncate text-[11px]"
                style={{ color: "var(--ws-text-2)" }}
              >
                Brand workspace
              </span>
            </span>
            <ChevronDown
              className="size-3.5 shrink-0"
              style={{ color: "var(--ws-text-2)" }}
            />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={compact ? "right" : "bottom"}
        className="w-[300px] rounded-[14px] border p-2 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <div
          className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wider"
          style={{ color: "var(--ws-text-3)" }}
        >
          YOUR BRANDS
        </div>
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm"
            style={{ color: "var(--ws-text)" }}
            // The brand already open: nothing to do (opening it would start a
            // new chat in place of the conversation on screen).
            onClick={() => {
              if (project.id !== activeProjectId) {
                router.push(`/projects/${project.id}`);
              }
            }}
          >
            <Avatar name={project.name} size={28} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === activeProjectId ? (
              <Check
                className="size-3.5 shrink-0"
                style={{ color: "var(--ws-text)" }}
              />
            ) : null}
          </DropdownMenuItem>
        ))}
        {projects.length === 0 ? (
          <p
            className="px-2 py-1.5 text-xs"
            style={{ color: "var(--ws-text-3)" }}
          >
            No brands yet.
          </p>
        ) : null}
        <DropdownMenuSeparator
          style={{ background: "var(--ws-border)" }}
          className="my-1.5"
        />
        <DropdownMenuItem
          render={<Link href="/projects/new" />}
          className="flex items-center gap-1.5 rounded-xl px-2 py-2 text-sm"
          style={{ color: "var(--ws-text-2)" }}
        >
          <Plus className="size-3.5" />
          Add brand
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
