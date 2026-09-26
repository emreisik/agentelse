"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Brand Workspace header's brand switcher — a dedicated component rather
// than reusing ProjectSelect's <Select>: this dropdown (grouped label,
// serif-letter avatar rows, active-brand check, trailing "Add brand"
// row) doesn't fit a plain select list, but it's the exact same
// data/navigation ProjectSelect already uses (projects -> /projects/{id}).
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
}: {
  projects: { id: string; name: string; status: string }[];
  activeProjectId: string;
}) {
  const router = useRouter();
  const active = projects.find((p) => p.id === activeProjectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--ws-hover)]"
          />
        }
      >
        {active ? <Avatar name={active.name} size={28} /> : null}
        <span className="min-w-0 text-left leading-tight">
          <span
            className="block max-w-36 truncate text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {active?.name ?? "Select brand"}
          </span>
          <span
            className="block text-[11px]"
            style={{ color: "var(--ws-text-2)" }}
          >
            Brand workspace
          </span>
        </span>
        <ChevronDown
          className="size-3.5 shrink-0"
          style={{ color: "var(--ws-text-2)" }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
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
            onClick={() => router.push(`/projects/${project.id}`)}
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
