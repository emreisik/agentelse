import { NextResponse } from "next/server";

import {
  seoRunActive,
  type SeoRunPhase,
  type SeoRunKind,
} from "@/lib/module-flows/seo/state";
import { isRateLimited } from "@/lib/rate-limit";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import { readSeoCard, type SeoCardRead } from "@/server/modules/seo/card";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// SEO Manager kartının canlı akışı (docs/search-actions.md "SEO Manager"):
// arka plandaki model çağrısının evreleri. Kuyruk Job'u olmadığı için olay
// kuyruğu yoktur; uç kartı DB'den 1,5 sn'de bir yoklar ve yalnız değişen
// durumu yollar. `?run=<runId>` istemcinin başlattığı çalıştırmayı adlandırır:
// hata yalnız o çalıştırmanınsa bildirilir.
//   event: run  {"running":true,"kind","phase"}
//   event: end  {"ok":true,"step"} | {"ok":false,"message"}
//   : ping      10 sn'de bir; akış en çok 6 dakika sürer.

const POLL_MS = 1500;
const PING_MS = 10_000;
const MAX_MS = 6 * 60_000;
const MAX_READ_FAILURES = 5;
// Yetkili kullanıcı bile sınırsız akış açıp veritabanını yoklatamasın:
// bağlanma hızı ve eşzamanlı akış kullanıcı başına sınırlıdır; üyelik akış
// sürerken de yeniden denetlenir (projeden çıkarılan akışı sürdürmesin).
const CONNECT_LIMIT = 30;
const CONNECT_WINDOW_MS = 60_000;
const MAX_STREAMS_PER_USER = 3;
const ACCESS_RECHECK_MS = 60_000;
const openStreams = new Map<string, number>();

const NO_STORE = { "Cache-Control": "private, no-store" };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type RunSignal = { running: true; kind: SeoRunKind; phase: SeoRunPhase | null };

type Sample =
  | { type: "run"; signal: RunSignal }
  | { type: "end"; payload: { ok: true; step: string } | { ok: false; message: string } };

// Kartın şu anki hâlinden akışın bildireceği durum.
function sampleOf(read: SeoCardRead | null, runId: string | null): Sample {
  if (!read) {
    return { type: "end", payload: { ok: false, message: "This card is gone." } };
  }
  const { run, lastError } = read.state;
  if (run && seoRunActive(run) && (!runId || run.id === runId)) {
    return {
      type: "run",
      signal: { running: true, kind: run.kind, phase: run.phase ?? null },
    };
  }
  if (runId && lastError && lastError.runId === runId) {
    return { type: "end", payload: { ok: false, message: lastError.message } };
  }
  return { type: "end", payload: { ok: true, step: read.step } };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; commandId: string }> },
) {
  // Bayrak kapalıyken uç yokmuş gibi davranır (oturum sınanmadan önce).
  if (!SeoActionFlags.manager()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const { projectId, commandId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    throw error;
  }

  if (
    isRateLimited(`seo-live:${userId}`, CONNECT_LIMIT, CONNECT_WINDOW_MS) ||
    (openStreams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER
  ) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down for a moment." },
      { status: 429, headers: NO_STORE },
    );
  }

  const first = await readSeoCard(projectId, commandId);
  if (!first) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const rawRun = new URL(request.url).searchParams.get("run");
  const runId = rawRun && rawRun.length <= 64 ? rawRun : null;

  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closeStream: () => void = () => undefined;

  openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const startedAt = Date.now();
      let lastAccessCheck = Date.now();
      let lastWrite = Date.now();
      let lastSignal = "";
      let failures = 0;

      const write = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        } catch {
          closeStream();
        }
      };
      closeStream = () => {
        if (closed) return;
        closed = true;
        const open = (openStreams.get(userId) ?? 1) - 1;
        if (open > 0) openStreams.set(userId, open);
        else openStreams.delete(userId);
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener("abort", closeStream);
        try {
          controller.close();
        } catch {
          // akış zaten kapanmış
        }
      };
      request.signal.addEventListener("abort", closeStream);

      const handle = (read: SeoCardRead | null): void => {
        const sample = sampleOf(read, runId);
        if (sample.type === "end") {
          write(frame("end", sample.payload));
          closeStream();
          return;
        }
        const signature = JSON.stringify(sample.signal);
        if (signature !== lastSignal) {
          lastSignal = signature;
          write(frame("run", sample.signal));
        }
      };

      const tick = async (read: SeoCardRead | null | undefined) => {
        if (closed) return;
        if (Date.now() - lastAccessCheck >= ACCESS_RECHECK_MS) {
          lastAccessCheck = Date.now();
          try {
            await requireProjectAccess(userId, projectId);
          } catch (error) {
            if (isAgentelseError(error)) {
              write(
                frame("end", {
                  ok: false,
                  message: "You no longer have access to this project.",
                }),
              );
              closeStream();
              return;
            }
          }
          if (closed) return;
        }
        try {
          const current =
            read === undefined ? await readSeoCard(projectId, commandId) : read;
          failures = 0;
          handle(current);
        } catch (error) {
          failures += 1;
          console.error(
            "[seo-live] read failed:",
            error instanceof Error ? error.message : error,
          );
          if (failures >= MAX_READ_FAILURES) {
            write(
              frame("end", {
                ok: false,
                message: "Lost the connection. Refresh to see the card.",
              }),
            );
            closeStream();
            return;
          }
        }
        if (closed) return;
        if (Date.now() - startedAt >= MAX_MS) {
          // İstemci yeniden bağlanabilir; kartın kendi TTL'i sahipliği açar.
          closeStream();
          return;
        }
        if (Date.now() - lastWrite >= PING_MS) write(": ping\n\n");
        if (closed) return;
        timer = setTimeout(() => void tick(undefined), POLL_MS);
      };

      // İlk örnek yetki denetiminde zaten okundu: ikinci okuma yapılmaz.
      void tick(first);
    },
    cancel() {
      closeStream();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
