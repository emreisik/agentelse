import { cn } from "@/lib/utils";

export type TimelineEvent = {
  id: string;
  time: string;
  title: string;
  detail?: string;
  emphasis?: boolean;
};

// A linear log (the Proactive AI 08:12 → 08:46 sequence) — deliberately a
// plain <ol> with a CSS connector rather than FlowDiagram, since this is an
// ordered narrative, not a branching signal.
export function Timeline({
  events,
  className,
}: {
  events: TimelineEvent[];
  className?: string;
}) {
  return (
    <ol
      className={cn(
        "relative flex flex-col gap-6 border-l border-border pl-6",
        className,
      )}
    >
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            className={cn(
              "absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2 border-background",
              event.emphasis ? "bg-[var(--agentelse-accent)]" : "bg-border",
            )}
          />
          <time className="font-mono text-xs text-muted-foreground">
            {event.time}
          </time>
          <p
            className={cn(
              "mt-1 text-sm text-foreground",
              event.emphasis && "font-medium",
            )}
          >
            {event.title}
          </p>
          {event.detail ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {event.detail}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
