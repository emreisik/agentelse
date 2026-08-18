"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// ChatGPT'nin sidebar sohbet listesindeki davranışıyla aynı: başlık kutuya
// sığmıyorsa üzerine gelince (üst satırdaki `group/marquee`'nin hover'ında)
// metin yavaşça sola kayıp tamamı görünür, fare çekilince başa döner.
// Kayma mesafesi — dolayısıyla sabit bir piksel/saniye hızıyla süresi de —
// metnin GERÇEK taşma miktarına göre burada ölçülüp bir CSS custom
// property'ye yazılır; CSS tek başına (içerik dinamik olduğu için) bunu
// bilemez. Sığan başlıklarda taşma 0 olduğundan hover'ın hiçbir görünür
// etkisi olmaz — ayrı bir "kaydırılabilir mi" dalı gerekmez.
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
