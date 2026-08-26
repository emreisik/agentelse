type LocalWorkerEnvironment = {
  NEXT_RUNTIME?: string;
  NODE_ENV?: string;
  ENABLE_LOCAL_WORKER?: string;
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
