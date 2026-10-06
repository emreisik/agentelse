type LocalWorkerEnvironment = {
  NEXT_RUNTIME?: string;
  NODE_ENV?: string;
  ENABLE_LOCAL_WORKER?: string;
  ENABLE_INPROCESS_WORKER?: string;
};

// Opt-IN, not opt-out. This process's DATABASE_URL is, by this project's own
// convention, routinely the same live database production reads from (see
// memory: shared-remote-db) — so "npm run dev" silently starting a worker
// here means a developer's laptop starts claiming and executing REAL
// production execution jobs the moment it's running, with no visibility.
// Confirmed in production: a long-lived local dev server (started before a
// same-day asset-storage.ts fix) kept ticking against the shared prod DB for
// ~40 hours, processing real user creative-generation jobs with stale code
// and writing their images to this machine's own disk — invisible to
// anyone until the resulting Asset rows 404'd in the actual app. A machine
// that wants this convenience must ask for it explicitly.
export function shouldStartLocalWorker(env: LocalWorkerEnvironment): boolean {
  return (
    env.NEXT_RUNTIME === "nodejs" &&
    env.NODE_ENV === "development" &&
    env.ENABLE_LOCAL_WORKER === "true"
  );
}

// Production counterpart, also opt-in: Railway runs `next start` as a
// long-lived container, so the same in-process interval loop works there and
// ticks every few seconds instead of waiting on the external /api/cron/worker
// trigger (GitHub Actions `*/5`, which in practice fires every 5-20 min and
// was the main source of end-to-end latency). Set ENABLE_INPROCESS_WORKER=true
// on exactly ONE service (the web service). The external cron can stay as a
// fallback: ExecutionWorker.tick() coalesces overlapping calls in-process and
// outbox claims are compare-and-swap, so a double trigger never double-runs
// a job.
export function shouldStartProductionWorker(
  env: LocalWorkerEnvironment,
): boolean {
  return (
    env.NEXT_RUNTIME === "nodejs" &&
    env.NODE_ENV === "production" &&
    env.ENABLE_INPROCESS_WORKER === "true"
  );
}

type MetaWorkEnvironment = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
};

// Tek kullanımlık yerel Postgres: localhost ya da Unix soketi (?host=/...).
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const socketHost = parsed.searchParams.get("host");
    if (socketHost?.startsWith("/")) return true;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      parsed.hostname,
    );
  } catch {
    return false;
  }
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken Meta işlerini ve
// Meta tick adımlarını hiç almaz (docs/meta-ads-plan.md F0b, K19): aksi hâlde
// gerçek müşteri token'larıyla yerelden harcama yapılabilir ya da canlı bir
// lansman yerel işçide FAILED olabilirdi. Yerel tek kullanımlık veritabanında
// her şey çalışır.
export function metaWorkExcludedHere(env: MetaWorkEnvironment): boolean {
  return env.NODE_ENV === "development" && !isLocalDatabaseUrl(env.DATABASE_URL);
}
