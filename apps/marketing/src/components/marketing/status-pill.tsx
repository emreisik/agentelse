import { cn } from "@/lib/utils";

export type StatusPillTone =
  "signal" | "decision" | "coordination" | "execution" | "neutral" | "accent";

const TONE_CLASSES: Record<StatusPillTone, string> = {
  signal: "border-border text-foreground/70",
  decision: "border-border text-foreground/70",
  coordination: "border-border text-foreground/70",
  execution: "border-border text-foreground/70",
  neutral: "border-border text-muted-foreground",
  accent:
    "border-[var(--agentelse-accent)] bg-[var(--agentelse-accent)] text-[var(--agentelse-accent-foreground)]",
};

export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusPillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "agentelse-text-caption inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 font-medium uppercase",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          tone !== "accent" && "opacity-60",
        )}
      />
      {children}
    </span>
  );
}
