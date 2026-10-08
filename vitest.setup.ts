import { vi } from "vitest";

// "server-only" throws by design when required outside Next.js's webpack
// build (it's Next's own client/server boundary guard, enforced entirely
// via bundler aliasing) — Vitest runs plain Node, so stub it to a no-op.
vi.mock("server-only", () => ({}));

// Billing usage rows (UsageEntry) are written by every paid-call client. Unit
// tests never have a database, so the recorder is a no-op everywhere; the
// recorder's own tests import the real module via vi.importActual, and client
// tests assert on this mock.
vi.mock("@/server/billing/usage-recorder", async (importActual) => {
  const actual =
    await importActual<typeof import("@/server/billing/usage-recorder")>();
  return { ...actual, recordUsage: vi.fn(async () => undefined) };
});
