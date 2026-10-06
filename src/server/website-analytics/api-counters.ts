import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  addCounts,
  gaHourKey,
  parseGaApiCounters,
  sumLastHours,
  trimHours,
} from "@/lib/website-analytics/api-counters";
import {
  GaFlags,
  gaGlobalWorkAllowedHere,
} from "@/lib/website-analytics/flags";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";

// GA API sayaçları (docs/google-analytics-plan.md §3.9, GA-F2 bölüm 2): her
// Google çağrısının sonucu süreç belleğinde `${saat}|${sonuç}` anahtarıyla
// sayılır (sayı gerçekleştiği saatte kalır) ve SystemHeartbeat "ga.api"
// satırına boşaltılır: kayıtta en çok dakikada bir, her GaSync.runDue
// sonunda ve GaLive'ın her Google çağrısından sonra. Canlı veritabanını
// paylaşan geliştirme süreci asla yazmaz. Okuma-değiştir-yaz yarışında
// kaybolan artışlar kabul edilir (yalnız operatör sayaçları).

export type GaApiOutcome = "ok" | GoogleErrorClass;

const HEARTBEAT_KEY = "ga.api";
const FLUSH_EVERY_MS = 60_000;
const WINDOW_HOURS = 24;

const pending = new Map<string, number>();
let lastFlushAt = 0;

export function recordGaApiOutcome(outcome: GaApiOutcome, count = 1): void {
  try {
    if (!GaFlags.sync() || count <= 0) return;
    const now = new Date();
    const key = `${gaHourKey(now)}|${outcome}`;
    pending.set(key, (pending.get(key) ?? 0) + count);
    if (now.getTime() - lastFlushAt >= FLUSH_EVERY_MS) {
      lastFlushAt = now.getTime();
      void flushGaApiCounters(now).catch(() => {});
    }
  } catch {
    // Sayaç asla çağrıyı düşürmez.
  }
}

function snapshotByHour(
  snapshot: [string, number][],
): Map<string, Record<string, number>> {
  const byHour = new Map<string, Record<string, number>>();
  for (const [key, count] of snapshot) {
    const at = key.indexOf("|");
    const hour = key.slice(0, at);
    const outcome = key.slice(at + 1);
    const counts = byHour.get(hour) ?? {};
    counts[outcome] = (counts[outcome] ?? 0) + count;
    byHour.set(hour, counts);
  }
  return byHour;
}

async function writePending(now: Date): Promise<void> {
  const snapshot = [...pending.entries()];
  if (snapshot.length === 0) return;
  lastFlushAt = now.getTime();
  try {
    const current = await prisma.systemHeartbeat.findUnique({
      where: { key: HEARTBEAT_KEY },
      select: { data: true },
    });
    let data = parseGaApiCounters(current?.data ?? null);
    for (const [hour, counts] of snapshotByHour(snapshot)) {
      data = addCounts(data, hour, counts);
    }
    const trimmed = trimHours(
      data ?? { v: 1, hours: {} },
      now,
    ) as unknown as Prisma.InputJsonValue;
    await prisma.systemHeartbeat.upsert({
      where: { key: HEARTBEAT_KEY },
      create: { key: HEARTBEAT_KEY, data: trimmed },
      update: { data: trimmed },
    });
    // Yalnız yazılanlar düşülür; bu arada gelen artışlar kalır.
    for (const [key, count] of snapshot) {
      const left = (pending.get(key) ?? 0) - count;
      if (left > 0) pending.set(key, left);
      else pending.delete(key);
    }
  } catch (error) {
    console.warn(
      "[ga-api] counters could not be written:",
      error instanceof Error ? error.message : error,
    );
  }
}

// Aynı anda tek boşaltma: aynı anlık görüntü iki kez yazılmasın.
let flushing: Promise<void> | null = null;

export async function flushGaApiCounters(
  now: Date = new Date(),
): Promise<void> {
  if (!GaFlags.sync() || !gaGlobalWorkAllowedHere()) return;
  while (flushing) await flushing;
  flushing = writePending(now);
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

// Son 24 saat: saklananlar + henüz yazılmamışlar.
export async function readGaApiCounters(now: Date = new Date()): Promise<{
  windowHours: 24;
  calls: number;
  errors: Partial<Record<GoogleErrorClass, number>>;
}> {
  const row = await prisma.systemHeartbeat.findUnique({
    where: { key: HEARTBEAT_KEY },
    select: { data: true },
  });
  let data = parseGaApiCounters(row?.data ?? null);
  for (const [hour, counts] of snapshotByHour([...pending.entries()])) {
    data = addCounts(data, hour, counts);
  }
  const totals = sumLastHours(data, now, WINDOW_HOURS);
  let calls = 0;
  const errors: Partial<Record<GoogleErrorClass, number>> = {};
  for (const [outcome, count] of Object.entries(totals)) {
    calls += count;
    if (outcome !== "ok") errors[outcome as GoogleErrorClass] = count;
  }
  return { windowHours: WINDOW_HOURS, calls, errors };
}

// Testler için.
export function resetGaApiCounters(): void {
  pending.clear();
  lastFlushAt = 0;
}
