import type { ReactNode } from "react";

// The title row every card in the right panel's Brand tab opens with: a small
// icon that says what the card is about, the title, and an optional action on
// the right. One look across the tab, so a glance at the icons finds the card.
export function CardTitle({
  icon,
  children,
  aside,
}: {
  icon: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2
        className="flex min-w-0 items-center gap-2 text-sm font-semibold"
        style={{ color: "var(--ws-text)" }}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md [&>svg]:size-3.5"
          style={{
            background: "var(--ws-surface-2)",
            color: "var(--ws-text-2)",
          }}
        >
          {icon}
        </span>
        <span className="truncate">{children}</span>
      </h2>
      {aside ?? null}
    </div>
  );
}
