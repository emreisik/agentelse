// Next.js instrumentation hook — runs once when the server process starts.
// In local development this is what makes the PostgreSQL-backed worker loop
// active without any separate process, Docker, or Redis. In production
// (Railway/serverless) prefer hitting /api/cron/worker on a schedule instead
// — a long-lived setInterval does not survive serverless cold starts.
import { shouldStartLocalWorker } from "@/lib/local-worker-policy";

export async function register() {
  if (!shouldStartLocalWorker(process.env)) return;

  const { ExecutionWorker } = await import("@/server/workers/execution-worker");

  const TICK_MS = 3_000;
  setInterval(() => {
    ExecutionWorker.tick().catch((error) => {
      console.error("[worker] tick failed", error);
    });
  }, TICK_MS);

  console.log(
    `[worker] local execution worker started (tick every ${TICK_MS}ms)`,
  );
}
