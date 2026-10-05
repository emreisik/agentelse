"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode, Ref } from "react";

import { MODULE_KEYS, MODULES, type ModuleKey } from "@/lib/modules/catalog";
import { cn } from "@/lib/utils";

import { ModuleIcon } from "./module-icon";

// A New Chat's first choice with modules on (plan P4): one tile per module
// under the composer, 2 by 2 on a phone and 4 across where the chat is wide (a
// container query on the thread: the chat narrows when the side panels open).
// A ready module goes on in the chat itself (use-module-choice.ts): the
// Social Media Planner sends its first message, the others write their card.
// One that is not built yet says so quietly and does nothing, except Ads
// Manager, which opens today's Ads account page until its module ships.
// Presentational: the parent owns the choice.

export const MODULE_LAUNCHER_COPY = {
  groupAria: "Start with a module",
  start: "Start",
  comingSoon: "Coming soon",
  openAds: "Open Ads account",
} as const;

export type LauncherTile =
  { kind: "start" } | { kind: "link"; href: string } | { kind: "soon" };

// What a module's tile does.
export function launcherTileOf(
  module: ModuleKey,
  projectId: string,
): LauncherTile {
  if (MODULES[module].ready) return { kind: "start" };
  if (module === "ads") {
    return { kind: "link", href: `/projects/${projectId}/ads` };
  }
  return { kind: "soon" };
}

const TILE =
  "flex h-full w-full min-w-0 flex-col items-start rounded-2xl border p-3 text-left sm:p-3.5";
const ACTIVE =
  "bg-[var(--ws-surface)] outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring";

function TileBody({ module, muted }: { module: ModuleKey; muted: boolean }) {
  const def = MODULES[module];
  return (
    <>
      <span
        className="grid size-8 shrink-0 place-items-center rounded-[10px]"
        style={{
          background: "var(--ws-surface-2)",
          color: muted ? "var(--ws-text-3)" : "var(--ws-text)",
        }}
      >
        <ModuleIcon module={module} />
      </span>
      <span
        className="mt-2.5 text-[13px] leading-snug font-semibold"
        style={{ color: muted ? "var(--ws-text-2)" : "var(--ws-text)" }}
      >
        {def.label}
      </span>
      <span
        className="mt-1 line-clamp-2 text-xs leading-snug"
        style={{ color: muted ? "var(--ws-text-3)" : "var(--ws-text-2)" }}
      >
        {def.blurb}
      </span>
    </>
  );
}

// The tile's last line, held to the bottom so the four tiles line up.
function TileNote({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="mt-auto inline-flex items-center gap-1 pt-2.5 text-[11px] font-medium"
      style={{ color }}
    >
      {children}
    </span>
  );
}

export function ModuleLauncher({
  projectId,
  disabled = false,
  onChoose,
  firstTileRef,
}: {
  projectId: string;
  // A message is being sent, or the chat is not open.
  disabled?: boolean;
  onChoose: (module: ModuleKey) => void;
  // The first module that starts here: what the focus comes back to.
  firstTileRef?: Ref<HTMLButtonElement>;
}) {
  const first = MODULE_KEYS.find(
    (key) => launcherTileOf(key, projectId).kind === "start",
  );
  return (
    <ul
      aria-label={MODULE_LAUNCHER_COPY.groupAria}
      className="grid grid-cols-2 gap-2 @3xl:grid-cols-4"
    >
      {MODULE_KEYS.map((key) => {
        const tile = launcherTileOf(key, projectId);
        return (
          <li key={key} className="min-w-0">
            {tile.kind === "start" ? (
              <button
                ref={key === first ? firstTileRef : undefined}
                type="button"
                disabled={disabled}
                onClick={() => onChoose(key)}
                className={cn(
                  TILE,
                  ACTIVE,
                  "enabled:hover:bg-[var(--ws-hover)] disabled:opacity-50",
                )}
                style={{
                  borderColor: "var(--ws-border)",
                  boxShadow: "var(--ws-card-shadow)",
                }}
              >
                <TileBody module={key} muted={false} />
                <TileNote color="var(--ws-text)">
                  {MODULE_LAUNCHER_COPY.start}
                  <ArrowRight aria-hidden="true" className="size-3" />
                </TileNote>
              </button>
            ) : tile.kind === "link" ? (
              <Link
                href={tile.href}
                className={cn(TILE, ACTIVE, "hover:bg-[var(--ws-hover)]")}
                style={{ borderColor: "var(--ws-border)" }}
              >
                <TileBody module={key} muted={false} />
                <TileNote color="var(--ws-text-2)">
                  {MODULE_LAUNCHER_COPY.openAds}
                  <ArrowUpRight aria-hidden="true" className="size-3" />
                </TileNote>
              </Link>
            ) : (
              <div className={TILE} style={{ borderColor: "var(--ws-border)" }}>
                <TileBody module={key} muted />
                <TileNote color="var(--ws-text-3)">
                  {MODULE_LAUNCHER_COPY.comingSoon}
                </TileNote>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
