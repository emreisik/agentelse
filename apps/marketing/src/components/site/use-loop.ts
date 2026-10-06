"use client";

import { useEffect, useRef, useState } from "react";

// Steps through `phases` every `stepMs` while the element is on screen, for
// the small looping product pictures. Under reduced motion it rests on the
// last phase: the finished picture.
export function useLoop(phases: number, stepMs: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = window.setTimeout(() => setPhase(phases - 1), 0);
      return () => window.clearTimeout(id);
    }
    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        window.clearInterval(timer);
        if (entry?.isIntersecting) {
          timer = window.setInterval(
            () => setPhase((value) => (value + 1) % phases),
            stepMs,
          );
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [phases, stepMs]);

  return { ref, phase };
}
