"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// Same behavior as ChatGPT's sidebar chat list: if the title doesn't fit
// the box, hovering over it (on the `group/marquee` hover from the parent
// row) slowly scrolls the text left until it's fully visible, and it
// resets when the mouse leaves. The scroll distance — and therefore the
// duration at a fixed pixels/second speed — is measured here from the
// text's ACTUAL overflow amount and written to a CSS custom property;
// CSS alone can't know this (since the content is dynamic). Titles that
// fit have zero overflow, so hover has no visible effect — no separate
// "is it scrollable" branch is needed.
export function MarqueeText({
  children,
  className,
  speedPxPerSecond = 32,
}: {
  children: React.ReactNode;
  className?: string;
  speedPxPerSecond?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const measure = () => {
      setOverflow(Math.max(0, text.scrollWidth - container.clientWidth));
    };
    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [children]);

  const durationMs =
    overflow > 0 ? Math.round((overflow / speedPxPerSecond) * 1000) : 0;

  return (
    <div
      ref={containerRef}
      className={cn("min-w-0 overflow-hidden", className)}
    >
      <span
        ref={textRef}
        className="inline-block max-w-none [transition-property:transform] [transition-timing-function:linear] group-hover:translate-x-[var(--marquee-offset)]"
        style={
          {
            "--marquee-offset": `-${overflow}px`,
            transitionDuration: `${durationMs}ms`,
            whiteSpace: "nowrap",
          } as React.CSSProperties
        }
      >
        {children}
      </span>
    </div>
  );
}
