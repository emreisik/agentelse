import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  HEARTBEAT_KEYS,
  heartbeatLevel,
  lastSignOfLife,
} from "@/lib/heartbeat";
import { Heartbeat } from "@/server/observability/heartbeat";

// Canlılık ucu (docs/meta-ads-plan.md F0b, §3.6 "İzleyeni kim izler?").
//
//   GET /api/health           süreç ayakta ve veritabanına erişiliyor mu?
//                             (Railway healthcheck bunu yalnız deploy
//                             başında çağırır)
//   GET /api/health?worker=1  ek olarak işçi nabzı: son tick 10 dakikadan
//                             eskiyse ya da hiç yoksa 503 (harici monitör)
//
// Oturum istemez (public-paths.ts); yanıt yalnız durum taşır, kiracı verisi
// ya da hata metni taşımaz.
export async function GET(request: Request) {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json(
      { ok: false, database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const wantsWorker = new URL(request.url).searchParams.get("worker") === "1";
  if (!wantsWorker) {
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const now = new Date();
  const snapshot = await Heartbeat.read(HEARTBEAT_KEYS.WORKER_TICK).catch(
    () => null,
  );
  const level = heartbeatLevel(snapshot, now);
  const last = snapshot ? lastSignOfLife(snapshot) : null;
  const healthy = level === "ok" || level === "warn";
  return NextResponse.json(
    {
      ok: healthy,
      worker: { level, lastSignOfLifeAt: last?.toISOString() ?? null },
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
