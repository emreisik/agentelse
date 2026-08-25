// Next.js instrumentation hook — runs once when the server process starts.
// In local development this is what makes the PostgreSQL-backed worker loop
// active without any separate process, Docker, or Redis. In production
// (Railway/serverless) prefer hitting /api/cron/worker on a schedule instead
// — a long-lived setInterval does not survive serverless cold starts.
import { shouldStartLocalWorker } from "@/lib/local-worker-policy";

export async function register() {
  // One boot-time snapshot of which integrations THIS process actually
  // sees. getEnv() reads process.env once and caches it for the process
  // lifetime, so an env var added in the Railway dashboard while a
  // container keeps running is invisible until a restart — that's exactly
  // how creatives silently landed on the ephemeral local disk (and died on
  // the next redeploy) while the panel showed R2 fully configured. This
  // line turns that mismatch into something grep-able in the deploy log.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { isIntegrationConfigured } = await import("@/lib/env");
    const summary = (
      ["R2", "GEMINI", "OPENAI", "OPENCLAW_GATEWAY", "TELEGRAM"] as const
    )
      .map((key) => `${key}=${isIntegrationConfigured(key) ? "on" : "OFF"}`)
      .join(" ");
    console.log(`[boot] integrations: ${summary}`);
    if (!isIntegrationConfigured("R2")) {
      console.warn(
        "[boot] R2 is NOT configured — assets will be written to the ephemeral local disk and will be lost on the next redeploy",
      );
    }
  }

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
