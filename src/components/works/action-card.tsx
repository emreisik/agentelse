import type { CSSProperties, ComponentType, ReactNode } from "react";
import { Check } from "lucide-react";

import { CardHeading } from "@/components/works/card-focus";
import { WsStatusPill, type WsTone } from "@/components/commands/ws-event-card";
import { cn } from "@/lib/utils";

// The one shell of every Works card: exactly the WsEventCard classes, so a
// kit card sits flush with the legacy ones in the same timeline. Presentational
// and server-renderable; only the heading is a client leaf (focus on mount).

type IconComponent = ComponentType<{
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export function ActionCard({
  icon: Icon,
  title,
  status,
  reason,
  width = "md",
  resolved,
  footnote,
  muted = false,
  cardId,
  commandId,
  children,
  actions,
}: {
  icon: IconComponent;
  title: string;
  status?: { label: string; tone?: WsTone };
  // One line under the title: why the card is offered.
  reason?: string;
  width?: "md" | "wide";
  // A finished card collapses to one receipt row carrying this label; the
  // children are dropped, the actions (a "Change" button) stay.
  resolved?: string;
  footnote?: string;
  // A superseded card: dashed border, never faded text.
  muted?: boolean;
  cardId?: string;
  commandId?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  // No hooks here (server-renderable): the id comes from the card's own keys.
  const titleId = `card-title-${commandId ?? cardId ?? "card"}`;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-card={cardId}
      data-card-id={commandId}
      className={cn(
        "mt-1 w-full space-y-2 rounded-2xl border p-3.5",
        width === "wide" ? "max-w-xl" : "max-w-md",
        muted && "border-dashed",
      )}
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      {resolved !== undefined ? (
        <>
          <div className="flex items-start gap-2.5">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--ws-hover)" }}
            >
              <Check
                className="size-3.5"
                style={{ color: "var(--ws-approved)" }}
                aria-hidden="true"
              />
            </span>
            <CardHeading id={titleId} commandId={commandId}>
              {resolved}
            </CardHeading>
          </div>
          {actions}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--ws-hover)" }}
            >
              <Icon
                className="size-3.5"
                style={{ color: "var(--ws-text)" }}
                aria-hidden="true"
              />
            </span>
            <CardHeading id={titleId} commandId={commandId}>
              {title}
            </CardHeading>
            {status ? (
              <WsStatusPill
                label={status.label}
                tone={status.tone}
                className="max-[400px]:w-full"
              />
            ) : null}
          </div>
          {reason ? (
            <p
              className="text-xs leading-5"
              style={{ color: "var(--ws-text-2)" }}
            >
              {reason}
            </p>
          ) : null}
          {children}
          {actions}
          {footnote ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {footnote}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
