import { formatCount } from "@/lib/module-flows/analytics/format";
import type { AiTrafficView } from "@/lib/seo/geo/view-types";

// Yapay zekâ asistanlarından gelen ziyaretler (SC-F8 "AI trafiği köprüsü"):
// Google Analytics'ten canlı okunan iki pencerenin sayıları. Hiçbir yerde
// saklanmaz; yalnız GA bağlı ve alan adı eşleşiyorsa gösterilir.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function changeText(now: number, before: number): string {
  if (before === 0) return now === 0 ? "No change" : "New in this period";
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return "No change";
  return `${pct > 0 ? "Up" : "Down"} ${Math.abs(pct)}% from the 28 days before`;
}

export function AiTrafficCard({ traffic }: { traffic: AiTrafficView }) {
  const empty = traffic.sessions === 0 && traffic.previousSessions === 0;
  return (
    <div className={CARD} data-card="ai-traffic">
      <p className="text-sm font-medium">Visits from AI assistants</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {dayLabel(traffic.from)} to {dayLabel(traffic.to)}, from Google
        Analytics
      </p>
      {empty ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No visits from AI assistants in this period yet.
        </p>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {formatCount(traffic.sessions)}
            </span>
            <span className="text-muted-foreground">
              sessions · {changeText(traffic.sessions, traffic.previousSessions)}
            </span>
          </div>
          <p className="text-muted-foreground">
            {traffic.sharePct !== null
              ? `${traffic.sharePct}% of all sessions. `
              : ""}
            {formatCount(traffic.keyEvents)} key events from these visits.
          </p>
          {traffic.assistants.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {traffic.assistants.map((assistant) => (
                <li
                  key={assistant.name}
                  className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                >
                  {assistant.name} {formatCount(assistant.sessions)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Shown live and never saved. A link click is not proof that an AI answer
        quoted your site.
      </p>
    </div>
  );
}
