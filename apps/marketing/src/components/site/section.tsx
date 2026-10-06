import { cn } from "@/lib/utils";
import { Reveal } from "@/components/site/reveal";

// The four-point spark of the logo, drawn so it can sit inline with text.
export function Spark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-3.5 text-spark", className)}
      fill="currentColor"
    >
      <path d="M12 0c.9 6.4 5.1 10.8 12 12-6.9 1.2-11.1 5.6-12 12-.9-6.4-5.1-10.8-12-12C6.9 10.8 11.1 6.4 12 0Z" />
    </svg>
  );
}

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "inline-flex items-center gap-2 text-sm font-medium text-muted-foreground",
        className,
      )}
    >
      <Spark />
      {children}
    </p>
  );
}

export function Section({
  children,
  id,
  tone = "plain",
  wide = false,
  className,
  innerClassName,
}: {
  children: React.ReactNode;
  id?: string;
  tone?: "plain" | "muted" | "ink";
  wide?: boolean;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "site-section scroll-mt-16",
        tone === "muted" && "bg-muted",
        tone === "ink" && "bg-primary text-primary-foreground",
        className,
      )}
    >
      <div
        className={cn(
          wide ? "site-container-wide" : "site-container",
          innerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  lead,
  align = "left",
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <Reveal
      className={cn(
        "flex flex-col gap-4",
        align === "center" && "items-center text-center",
        className,
      )}
    >
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="text-h2 max-w-[20ch] text-balance">{title}</h2>
      {lead ? (
        <p className="text-lead max-w-[58ch] text-pretty text-muted-foreground">
          {lead}
        </p>
      ) : null}
    </Reveal>
  );
}
