// The Agentelse mark: a signal moving through decision → coordination →
// execution, traced inside a single badge. Solid ink badge (not an outline)
// so the glyph reads with full contrast and weight at any size. Kept in sync
// with apps/marketing/src/components/marketing/agentelse-mark.tsx — this app
// and marketing are separate Next.js apps with no shared package, so the
// small SVG is duplicated rather than pulled in as a dependency.
export function AgentelseMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6.5" fill="currentColor" />
      <path
        d="M5.75 15.75L10.5 9.5L14 13L18.25 7.75"
        fill="none"
        stroke="var(--background, #fff)"
        strokeWidth="2.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5.75" cy="15.75" r="1.65" fill="var(--background, #fff)" />
      <circle cx="10.5" cy="9.5" r="1.65" fill="var(--background, #fff)" />
      <circle cx="14" cy="13" r="1.65" fill="var(--background, #fff)" />
      <circle cx="18.25" cy="7.75" r="1.65" fill="var(--background, #fff)" />
    </svg>
  );
}
