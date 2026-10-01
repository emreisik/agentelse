"use client";

import { useId } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isSameOriginPath,
  normalizeButtons,
  type CardButton,
  type CardEmphasis,
} from "@/lib/works/card-action";

const VARIANT: Record<CardEmphasis, "default" | "outline" | "ghost"> = {
  primary: "default",
  secondary: "outline",
  quiet: "ghost",
};

// The button row of a card: at most three buttons, one primary, every one at
// least 44 px tall. A blocked button stays focusable (aria-disabled) and the
// card shows ONE visible line saying why.
export function CardActions({
  buttons,
  onAct,
  busyId = null,
  error = null,
  disabledAll = false,
  disabledReason = null,
}: {
  buttons: readonly CardButton[];
  onAct: (button: CardButton) => void;
  busyId?: string | null;
  error?: string | null;
  disabledAll?: boolean;
  // Why disabledAll is set; shown once under the row.
  disabledReason?: string | null;
}) {
  const reasonId = useId();
  const rows = normalizeButtons(buttons);
  const reasonOf = (button: CardButton): string | null =>
    button.disabledReason ?? (disabledAll ? disabledReason : null);
  const reasonLine =
    rows.map(reasonOf).find((reason) => !!reason) ?? disabledReason ?? null;
  const anyBusy = busyId !== null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {rows.map((button) => {
          const reason = reasonOf(button);
          const busy = busyId === button.id;
          const blocked = disabledAll || !!reason || anyBusy;
          const describedBy = reason ? reasonId : undefined;
          const className = cn(
            "min-h-11 rounded-lg px-4",
            blocked && "opacity-50",
            blocked && !busy && "cursor-not-allowed",
          );
          const { action } = button;
          if (action.kind === "link") {
            if (!isSameOriginPath(action.href)) return null;
            return (
              <Link
                key={button.id}
                href={action.href}
                data-emphasis={button.emphasis}
                aria-disabled={blocked ? "true" : undefined}
                aria-describedby={describedBy}
                onClick={(event) => {
                  if (blocked) event.preventDefault();
                }}
                className={cn(
                  buttonVariants({
                    variant: VARIANT[button.emphasis],
                    size: "sm",
                  }),
                  className,
                )}
              >
                {button.label}
              </Link>
            );
          }
          return (
            <Button
              key={button.id}
              type="button"
              size="sm"
              variant={VARIANT[button.emphasis]}
              data-emphasis={button.emphasis}
              aria-disabled={blocked ? "true" : undefined}
              aria-describedby={describedBy}
              aria-busy={busy ? "true" : undefined}
              className={className}
              onClick={() => {
                if (blocked) return;
                onAct(button);
              }}
            >
              {busy ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : null}
              {button.label}
            </Button>
          );
        })}
      </div>
      {reasonLine ? (
        <p
          id={reasonId}
          className="text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          {reasonLine}
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
