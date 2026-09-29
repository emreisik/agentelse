import { ChevronRight } from "lucide-react";
import type { DepartmentKey } from "@prisma/client";

import { cn } from "@/lib/utils";
import { DepartmentBadge } from "@/components/shared/department-badge";
import { stripCapabilityPrefix } from "@/lib/labels";

// Shared visual language for every card the single project chat renders —
// signal/finding/idea/council/work-plan/task/approval/publish-result/etc.
// (idea-event-card.tsx) and creative-loading/ready/failed/publish-prompt
// (creative-card.tsx). Brings all card kinds onto ONE system: the
// `--ws-*` workspace-shell tokens (globals.css) CreativeReadyCard already
// established (see creative-card.tsx), instead of half the cards using
// that and the other half using the separate oklch semantic-tone classes
// (TONE_CLASSES/CARD_TONE_CLASSES in labels/). Color stays reserved for
// real state (waiting/danger) — department color is a DIFFERENT,
// deliberate signal (DepartmentBadge) and is untouched by this file.
export type WsTone = "neutral" | "positive" | "waiting" | "danger" | "special";

// Small status-dot color per tone — the SAME 3-tier convention
// CreativeReadyCard already uses for its status dot (waiting/danger,
// everything else = a plain workspace text tone). All four map onto the
// app's own semantic tokens (--ws-pending/--ws-approved alias
// --warning/--success; danger uses --destructive directly) rather than
// ad-hoc hex, so they stay correct in dark mode too.
const WS_TONE_DOT: Record<WsTone, string> = {
  neutral: "var(--ws-text-3)",
  positive: "var(--ws-approved)",
  waiting: "var(--ws-pending)",
  danger: "var(--destructive)",
  special: "var(--ws-olive)",
};

export function wsToneDotColor(tone: WsTone): string {
  return WS_TONE_DOT[tone];
}

// The small bordered pill used throughout CreativeReadyCard (dimensions,
// aspect ratio, "vN" version badge) — extracted here so every other card
// kind can use the exact same pill instead of inventing its own.
export function WsTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      {children}
    </span>
  );
}

// A tone-aware pill with a leading status dot — used for card badges
// ("Completed", "Awaiting approval", risk level, etc.). The dot is the
// ONLY place color appears; the pill itself stays monochrome.
export function WsStatusPill({
  label,
  tone = "neutral",
  className,
}: {
  label: string;
  tone?: WsTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        className,
      )}
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: wsToneDotColor(tone) }}
      />
      {label}
    </span>
  );
}

// The shared card shell every non-bespoke event uses: icon chip (always
// monochrome — state is conveyed by the badge dot, not by tinting the
// icon), title, optional status pill, optional department badge, optional
// body. Mirrors CreativeReadyCard's outer shell (rounded-2xl border,
// var(--ws-surface) background) so a signal/finding/task card sits
// visually flush with a creative-ready card in the same timeline.
export function WsEventCard({
  icon: Icon,
  iconClassName,
  title,
  tone = "neutral",
  badgeLabel,
  department,
  children,
}: {
  icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  iconClassName?: string;
  title: string;
  tone?: WsTone;
  badgeLabel?: string;
  department?: DepartmentKey;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="mt-1 w-full max-w-md space-y-2 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ws-hover)" }}
        >
          <Icon
            className={cn("size-3.5", iconClassName)}
            style={{ color: "var(--ws-text)" }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {stripCapabilityPrefix(title)}
          </p>
          {department ? (
            <DepartmentBadge
              department={department}
              size="xs"
              className="mt-0.5"
            />
          ) : null}
        </div>
        {badgeLabel ? <WsStatusPill label={badgeLabel} tone={tone} /> : null}
      </div>
      {children ? <div className="pl-9.5">{children}</div> : null}
    </div>
  );
}

// Collapsed-by-default long body (council rationale, task output, finding
// statement) — same interaction as before (native <details>/<summary>,
// chevron rotates open), just re-tokened onto --ws-*.
export function WsDetailToggle({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group/detail" open={defaultOpen || undefined}>
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-xs font-medium transition-colors select-none"
        style={{ color: "var(--ws-text-3)" }}
      >
        <ChevronRight className="size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-open/detail:rotate-90" />
        {label}
      </summary>
      <div
        className="mt-1.5 border-l-2 py-1 pl-3 text-sm whitespace-pre-wrap"
        style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
      >
        {children}
      </div>
    </details>
  );
}
