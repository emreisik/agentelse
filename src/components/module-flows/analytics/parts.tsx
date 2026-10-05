"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { Button } from "@/components/ui/button";
import type { AnalyticsSource } from "@/lib/module-flows/analytics/catalog";
import { cn } from "@/lib/utils";

// The small shared parts of the Analytics card: a source's brand mark, a group
// heading, the step's button row (quiet actions, then the ONE primary) and the
// lines under it. Presentational: the steps own every state and action.

const SOURCE_BRAND: Readonly<Record<AnalyticsSource, BrandKey>> = {
  instagram: "instagram",
  metaAds: "meta-ads",
  ga4: "ga4",
  searchConsole: "search-console",
};

// The source's own mark; its name is always written beside it.
export function SourceMark({
  source,
  className,
}: {
  source: AnalyticsSource;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
        className,
      )}
      style={{ background: "var(--ws-surface-2)" }}
    >
      <BrandIcon brand={SOURCE_BRAND[source]} className="size-[60%]" />
    </span>
  );
}

export function GroupHeading({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      className="text-[11px] font-medium tracking-[0.08em] uppercase"
      style={{ color: "var(--ws-text-2)" }}
    >
      {children}
    </p>
  );
}

type ActionButtonProps = {
  label: string;
  onClick: () => void;
  // Why it can't be used now; null = usable.
  blockedReason?: string | null;
  reasonId?: string;
  // Not usable while another action of the card runs (no reason to read).
  waiting?: boolean;
  busy?: boolean;
  busyLabel?: string;
  icon?: ReactNode;
};

function ActionButton({
  emphasis,
  label,
  onClick,
  blockedReason,
  reasonId,
  waiting = false,
  busy = false,
  busyLabel,
  icon,
}: ActionButtonProps & { emphasis: "primary" | "quiet" }) {
  const blocked = Boolean(blockedReason) || busy || waiting;
  return (
    <Button
      type="button"
      size="sm"
      variant={emphasis === "primary" ? "default" : "ghost"}
      data-emphasis={emphasis}
      // aria-disabled keeps it focusable, so its reason is read out.
      aria-disabled={blocked ? "true" : undefined}
      aria-describedby={blockedReason && reasonId ? reasonId : undefined}
      aria-busy={busy ? "true" : undefined}
      className={cn(
        "min-h-11 rounded-lg px-4",
        emphasis === "primary" && "w-full sm:w-auto",
        blocked && "opacity-50",
        blocked && !busy && !waiting && "cursor-not-allowed",
      )}
      onClick={() => {
        if (!blocked) onClick();
      }}
    >
      {busy ? (
        <Loader2
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        icon
      )}
      {busy && busyLabel ? busyLabel : label}
    </Button>
  );
}

export function PrimaryButton(props: ActionButtonProps) {
  return <ActionButton emphasis="primary" {...props} />;
}

export function QuietButton(props: ActionButtonProps) {
  return <ActionButton emphasis="quiet" {...props} />;
}

// The bottom of a step: quiet actions first, the primary last (full width on a
// phone), then why the primary is blocked and what went wrong.
export function StepActions({
  quiet,
  primary,
  reason,
  reasonId,
  error,
}: {
  quiet?: ReactNode;
  primary?: ReactNode;
  reason?: string | null;
  reasonId?: string;
  error?: string | null;
}) {
  return (
    <div
      className="space-y-2 border-t pt-3"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">{quiet}</div>
        {primary}
      </div>
      {reason ? (
        <p
          id={reasonId}
          className="text-xs sm:text-right"
          style={{ color: "var(--ws-text-2)" }}
        >
          {reason}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
