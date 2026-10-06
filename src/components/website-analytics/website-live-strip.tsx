"use client";

import { useEffect, useRef, useState } from "react";

import { formatCount } from "@/lib/module-flows/analytics/format";
import type {
  GaLiveUnavailable,
  GaRightNowResult,
  GaTodayResult,
} from "@/lib/website-analytics/live";

// Website sayfasının canlı şeridi (GA-F2 bölüm 2, GA_LIVE): "Today so far"
// (kısmi, mülk saatinde bugün) ve "Right now" (son 30 dakika). Sayfa
// görünürken yoklar: Right now dakikada bir, Today so far 15 dakikada bir
// (sunucu önbelleğinden). Başarısız yoklama önceki değeri korur.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
const TODAY_EVERY_MS = 15 * 60_000;
const NOW_EVERY_MS = 60_000;

type Part = "today" | "now";

function visible(): boolean {
  return document.visibilityState === "visible";
}

export function WebsiteLiveStrip({ projectId }: { projectId: string }) {
  const [today, setToday] = useState<GaTodayResult | null>(null);
  const [now, setNow] = useState<GaRightNowResult | null>(null);
  // Son deneme anı (ms); hata da sayılır ki Google'a yüklenilmesin.
  const lastTried = useRef<Record<Part, number>>({ today: 0, now: 0 });

  useEffect(() => {
    const controller = new AbortController();
    lastTried.current = { today: 0, now: 0 };

    async function load(part: Part) {
      lastTried.current[part] = Date.now();
      try {
        const res = await fetch(
          `/api/projects/${projectId}/website/live?part=${part}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (controller.signal.aborted) return;
        if (part === "today") setToday(body as GaTodayResult);
        else setNow(body as GaRightNowResult);
      } catch {
        // Önceki değer kalır.
      }
    }

    function refreshStale() {
      if (!visible()) return;
      const at = Date.now();
      if (at - lastTried.current.today >= TODAY_EVERY_MS) void load("today");
      if (at - lastTried.current.now >= NOW_EVERY_MS) void load("now");
    }

    refreshStale();
    const timer = window.setInterval(refreshStale, NOW_EVERY_MS);
    document.addEventListener("visibilitychange", refreshStale);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshStale);
    };
  }, [projectId]);

  return <WebsiteLiveView today={today} now={now} />;
}

function hidden(result: GaTodayResult | GaRightNowResult | null): boolean {
  return (
    result === null ||
    (!result.ok &&
      (result.reason === "off" || result.reason === "not_connected"))
  );
}

function unavailableMessage(reason: GaLiveUnavailable["reason"]): string {
  if (reason === "reconnect") {
    return "Reconnect Google Analytics to see live numbers.";
  }
  if (reason === "quota" || reason === "busy") {
    return "Live numbers are paused for a moment.";
  }
  return "Live numbers aren't available right now.";
}

// "14:05", mülk saatinde.
function timeLabel(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(date);
  } catch {
    return "";
  }
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0">
      <dd className="truncate font-heading text-xl font-semibold tabular-nums">
        {formatCount(value, true)}
      </dd>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}

function TodayCard({ result }: { result: GaTodayResult }) {
  return (
    <div className={CARD} data-live="today">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Today so far</p>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Partial
        </span>
      </div>
      {result.ok ? (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-2">
            <Stat value={result.today.sessions} label="Sessions" />
            <Stat value={result.today.activeUsers} label="Users" />
            <Stat value={result.today.keyEvents} label="Key events" />
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">
            As of {timeLabel(result.today.asOf, result.today.timeZone)} ·
            Property time
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {unavailableMessage(result.reason)}
        </p>
      )}
    </div>
  );
}

function NowCard({ result }: { result: GaRightNowResult }) {
  return (
    <div className={CARD} data-live="now">
      <p className="text-sm font-medium">Right now</p>
      {result.ok ? (
        <>
          <p className="mt-3 flex items-center gap-2 font-heading text-3xl font-semibold tabular-nums">
            {formatCount(result.now.activeUsers, true)}
            {result.now.activeUsers > 0 ? (
              <span
                aria-hidden
                className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse"
              />
            ) : null}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Active users in the last 30 minutes
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {unavailableMessage(result.reason)}
        </p>
      )}
    </div>
  );
}

export function WebsiteLiveView({
  today,
  now,
}: {
  today: GaTodayResult | null;
  now: GaRightNowResult | null;
}) {
  const showToday = !hidden(today);
  const showNow = !hidden(now);
  if (!showToday && !showNow) return null;
  return (
    <section className="grid gap-3 sm:grid-cols-2" aria-label="Live numbers">
      {showToday && today ? <TodayCard result={today} /> : null}
      {showNow && now ? <NowCard result={now} /> : null}
    </section>
  );
}
