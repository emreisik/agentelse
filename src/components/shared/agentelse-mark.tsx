// Kept in sync with apps/marketing/src/components/marketing/agentelse-mark.tsx
// — this app and marketing are separate Next.js apps with no shared package.
export function AgentelseMark({ className }: { className?: string }) {
  return (
    <img
      src="/agentelse.png"
      alt="Agentelse"
      className={className ? `${className} object-contain` : "object-contain"}
    />
  );
}
