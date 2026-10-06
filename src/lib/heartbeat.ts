// İşçi nabzının saf kuralları (docs/meta-ads-plan.md F0b, §3.6 "İzleyeni kim
// izler?"). Sunucu tarafı yazımı src/server/observability/heartbeat.ts'tedir;
// /api/health ve uygulama içi şerit bu eşiklerle karar verir.

export const HEARTBEAT_KEYS = {
  WORKER_TICK: "worker.tick",
} as const;

// Tick başına yazım en fazla dakikada bir.
export const HEARTBEAT_WRITE_EVERY_MS = 60_000;
// Şerit: 5 dakikadan eski nabız uyarı, 10 dakikadan eski kritik.
export const HEARTBEAT_WARN_AFTER_MS = 5 * 60_000;
export const HEARTBEAT_CRITICAL_AFTER_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const MAX_GAPS_KEPT = 10;

export type HeartbeatGap = { at: string; gapMs: number };

export type HeartbeatData = {
  gaps?: HeartbeatGap[];
};

export type HeartbeatLevel = "ok" | "warn" | "critical" | "never";

export type HeartbeatSnapshot = {
  lastBeatAt: Date | null;
  lastOkAt: Date | null;
};

// En son yaşam belirtisi: tick'in başı ya da sonu, hangisi yeniyse.
export function lastSignOfLife(snapshot: HeartbeatSnapshot): Date | null {
  const times = [snapshot.lastBeatAt, snapshot.lastOkAt].filter(
    (value): value is Date => value instanceof Date,
  );
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((value) => value.getTime())));
}

export function heartbeatLevel(
  snapshot: HeartbeatSnapshot | null,
  now: Date,
): HeartbeatLevel {
  const last = snapshot ? lastSignOfLife(snapshot) : null;
  if (!last) return "never";
  const age = now.getTime() - last.getTime();
  if (age > HEARTBEAT_CRITICAL_AFTER_MS) return "critical";
  if (age > HEARTBEAT_WARN_AFTER_MS) return "warn";
  return "ok";
}

// Önceki nabızla aradaki boşluğu kayda ekler; son 24 saatin en uzun
// boşluklarını (en çok 10) tutar.
export function recordGap(
  data: HeartbeatData | null | undefined,
  previousBeatAt: Date | null,
  now: Date,
): HeartbeatData {
  const cutoff = now.getTime() - DAY_MS;
  const kept = (data?.gaps ?? []).filter(
    (gap) => Date.parse(gap.at) >= cutoff && Number.isFinite(gap.gapMs),
  );
  if (previousBeatAt) {
    kept.push({
      at: now.toISOString(),
      gapMs: Math.max(0, now.getTime() - previousBeatAt.getTime()),
    });
  }
  kept.sort((a, b) => b.gapMs - a.gapMs);
  return { ...data, gaps: kept.slice(0, MAX_GAPS_KEPT) };
}

export function maxGapMs24h(
  data: HeartbeatData | null | undefined,
  now: Date,
): number {
  const cutoff = now.getTime() - DAY_MS;
  return (data?.gaps ?? [])
    .filter((gap) => Date.parse(gap.at) >= cutoff)
    .reduce((max, gap) => Math.max(max, gap.gapMs), 0);
}
