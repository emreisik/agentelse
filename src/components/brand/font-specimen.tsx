"use client";

import { useEffect, useState } from "react";

// Renders a brand font in the font itself. Fonts are usually web fonts the
// visitor's machine does not have, so the specimen loads the family from
// Google Fonts on demand; a brand font that is not on Google Fonts (a licensed
// or self-hosted face) cannot be previewed and is shown in a generic stand-in
// with a note saying so — never silently in the wrong font.

// The name ends up in a URL and a CSS declaration, so only ordinary font-name
// characters are accepted; anything else is shown as text in the stand-in.
const SAFE_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .\-]{0,58}$/;

const SERIF_HINT =
  /serif|playfair|georgia|times|lora|merriweather|cormorant|garamond|baskerville|didot|bodoni|libre caslon|crimson|spectral|fraunces|dm serif/i;
const MONO_HINT = /mono|code|courier|consolas/i;

function fallbackStack(name: string): string {
  if (/sans/i.test(name)) return "sans-serif";
  if (MONO_HINT.test(name)) return "monospace";
  if (SERIF_HINT.test(name)) return "serif";
  return "sans-serif";
}

const loads = new Map<string, Promise<boolean>>();

function loadGoogleFont(name: string): Promise<boolean> {
  const existing = loads.get(name);
  if (existing) return existing;
  const promise = new Promise<boolean>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}&display=swap`;
    link.onload = () => resolve(true);
    link.onerror = () => {
      link.remove();
      resolve(false);
    };
    document.head.appendChild(link);
  });
  loads.set(name, promise);
  return promise;
}

const ROLE_LABEL = ["Primary", "Secondary", "Accent"];

export function FontSpecimen({ name, index }: { name: string; index: number }) {
  const valid = SAFE_FONT_NAME.test(name);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">(
    valid ? "loading" : "missing",
  );

  useEffect(() => {
    if (!valid) return undefined;
    let cancelled = false;
    loadGoogleFont(name).then((ok) => {
      if (!cancelled) setStatus(ok ? "ready" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [name, valid]);

  const stack = fallbackStack(name);
  const fontFamily = status === "ready" ? `"${name}", ${stack}` : stack;

  return (
    <div
      className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <span
        className="w-12 shrink-0 text-4xl leading-none"
        style={{ fontFamily, color: "var(--ws-text)" }}
        aria-hidden
      >
        Aa
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className="truncate text-xs font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {name}
          </span>
          <span
            className="shrink-0 text-[9px] font-semibold tracking-[0.08em] uppercase"
            style={{ color: "var(--ws-text-3)" }}
          >
            {ROLE_LABEL[index] ?? "Accent"}
          </span>
        </div>
        <p
          className="truncate text-[13px]"
          style={{ fontFamily, color: "var(--ws-text-2)" }}
        >
          Aa Bb Ğğ Şş İı Öö Üü 0123
        </p>
        {status === "missing" ? (
          <p className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
            Preview font unavailable
          </p>
        ) : null}
      </div>
    </div>
  );
}
