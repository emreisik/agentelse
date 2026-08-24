export function AgentelseMark({ className }: { className?: string }) {
  return (
    <img
      src="/agentelse.png"
      alt="Agentelse"
      className={className ? `${className} object-contain` : "object-contain"}
    />
  );
}
