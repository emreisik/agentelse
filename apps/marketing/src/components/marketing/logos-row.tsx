import { cn } from "@/lib/utils";

// Text-mark badges rather than reproduced brand logos — monochrome by
// default, foreground on hover. Avoids both the "colorful logo soup" the
// brief warns against and the risk of hand-drawing inaccurate trademarked
// marks.
export function LogosRow({
  names,
  className,
}: {
  names: string[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-3", className)}>
      {names.map((name) => (
        <span
          key={name}
          className="rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground/70 transition-colors hover:border-[var(--agentelse-accent)]/40 hover:text-foreground"
        >
          {name}
        </span>
      ))}
    </div>
  );
}
