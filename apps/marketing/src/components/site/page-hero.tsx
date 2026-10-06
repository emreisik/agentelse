import { cn } from "@/lib/utils";
import { Reveal } from "@/components/site/reveal";
import { Eyebrow } from "@/components/site/section";

export function PageHero({
  eyebrow,
  title,
  lead,
  children,
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lead: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden pt-16 pb-14 sm:pt-24 sm:pb-20",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="site-glow pointer-events-none absolute inset-0 opacity-80"
      />
      <div className="site-container relative">
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="text-h1 mt-5 max-w-[18ch] text-balance">{title}</h1>
          <p className="text-lead mt-5 max-w-[60ch] text-pretty text-muted-foreground">
            {lead}
          </p>
          {children ? <div className="mt-8">{children}</div> : null}
        </Reveal>
      </div>
    </section>
  );
}
