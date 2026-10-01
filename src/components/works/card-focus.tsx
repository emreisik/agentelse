"use client";

import { useCallback, useEffect, useRef, type RefCallback } from "react";

import { useWorkCardHost } from "@/components/works/work-card-host";

// A card that replaces itself asks the host for focus BEFORE its server round
// trip; the NEW card takes it on mount, so a screen-reader user lands on the
// result instead of on <body>.

// The heading of an ActionCard. A focus call is a DOM side effect, not state.
export function CardHeading({
  id,
  commandId,
  children,
}: {
  id: string;
  commandId?: string;
  children: React.ReactNode;
}) {
  const host = useWorkCardHost();
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!commandId || !host) return;
    if (host.consumeFocus(commandId)) ref.current?.focus();
    // Mount only: a card is keyed by its command, a later host change must
    // not steal focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <h3
      id={id}
      ref={ref}
      tabIndex={-1}
      className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold outline-none"
      style={{ color: "var(--ws-text)" }}
    >
      {children}
    </h3>
  );
}

// For cards that are not ActionCards (the plan and creative cards): a ref for
// their wrapper element. The element must be focusable (tabIndex -1).
export function useCardFocus(commandId: string): RefCallback<HTMLElement> {
  const host = useWorkCardHost();
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      if (hostRef.current?.consumeFocus(commandId)) element.focus();
    },
    [commandId],
  );
}
