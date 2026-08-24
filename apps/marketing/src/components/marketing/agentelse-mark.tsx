// The square icon-only glyph (not the "agentelse" wordmark) — for small,
// icon-sized slots where a wide wordmark wouldn't fit legibly.
export function AgentelseMark({ className }: { className?: string }) {
  return (
    <img
      src="/fav.png"
      alt="Agentelse"
      className={className ? `${className} object-contain` : "object-contain"}
    />
  );
}
