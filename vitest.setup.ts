import { vi } from "vitest";

// "server-only" throws by design when required outside Next.js's webpack
// build (it's Next's own client/server boundary guard, enforced entirely
// via bundler aliasing) — Vitest runs plain Node, so stub it to a no-op.
vi.mock("server-only", () => ({}));
