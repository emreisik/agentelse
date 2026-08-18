import { cn } from "@/lib/utils";

type SectionProps = {
  children: React.ReactNode;
  id?: string;
  tone?: "paper" | "raised";
  wide?: boolean;
  className?: string;
  innerClassName?: string;
};

// Enforces consistent width + vertical rhythm only. Never prescribes inner
// layout — that's what lets every section's internal composition differ
// (split, editorial two-column, full-width diagram, statement) instead of
// repeating the same card-grid shape everywhere.
export function Section({
  children,
  id,
  tone = "paper",
  wide = false,
  className,
  innerClassName,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "agentelse-section-y",
        tone === "raised" && "bg-secondary/60",
        className,
      )}
    >
      <div
        className={cn(
          wide ? "agentelse-container-wide" : "agentelse-container",
          innerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
