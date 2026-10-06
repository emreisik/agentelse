import "server-only";

import { prisma } from "@/lib/prisma";
import {
  HEARTBEAT_WRITE_EVERY_MS,
  recordGap,
  type HeartbeatData,
  type HeartbeatSnapshot,
} from "@/lib/heartbeat";

// İşçi nabzı (docs/meta-ads-plan.md F0b). ExecutionWorker.tick başında
// beat(), sonunda ok() çağırır. Yazım en fazla dakikada birdir (süreç içi
// kısma); nabız yazılamazsa tick asla düşmez.

const lastWriteAt = new Map<string, number>();

function due(slot: string, now: Date): boolean {
  const last = lastWriteAt.get(slot) ?? 0;
  if (now.getTime() - last < HEARTBEAT_WRITE_EVERY_MS) return false;
  lastWriteAt.set(slot, now.getTime());
  return true;
}

export const Heartbeat = {
  async beat(key: string, now: Date = new Date()): Promise<void> {
    if (!due(`${key}:beat`, now)) return;
    try {
      const current = await prisma.systemHeartbeat.findUnique({
        where: { key },
        select: { lastBeatAt: true, data: true },
      });
      const data = recordGap(
        (current?.data as HeartbeatData | null) ?? null,
        current?.lastBeatAt ?? null,
        now,
      );
      await prisma.systemHeartbeat.upsert({
        where: { key },
        create: { key, lastBeatAt: now, data },
        update: { lastBeatAt: now, data },
      });
    } catch (error) {
      console.error(
        `[heartbeat] ${key} beat could not be written:`,
        error instanceof Error ? error.message : error,
      );
    }
  },

  async ok(
    key: string,
    now: Date = new Date(),
    lastError: string | null = null,
  ): Promise<void> {
    if (!due(`${key}:ok`, now)) return;
    try {
      await prisma.systemHeartbeat.upsert({
        where: { key },
        create: { key, lastOkAt: now, lastError },
        update: { lastOkAt: now, lastError },
      });
    } catch (error) {
      console.error(
        `[heartbeat] ${key} ok could not be written:`,
        error instanceof Error ? error.message : error,
      );
    }
  },

  async read(
    key: string,
  ): Promise<(HeartbeatSnapshot & { data: HeartbeatData | null }) | null> {
    const row = await prisma.systemHeartbeat.findUnique({ where: { key } });
    if (!row) return null;
    return {
      lastBeatAt: row.lastBeatAt,
      lastOkAt: row.lastOkAt,
      data: (row.data as HeartbeatData | null) ?? null,
    };
  },

  // Testler için süreç içi kısmayı sıfırlar.
  resetThrottleForTests(): void {
    lastWriteAt.clear();
  },
};
