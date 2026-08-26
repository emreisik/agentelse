import { describe, expect, it } from "vitest";

import { shouldStartLocalWorker } from "./local-worker-policy";

describe("local worker startup policy", () => {
  it("starts only in the Node.js development runtime with explicit opt-in", () => {
    expect(
      shouldStartLocalWorker({
        NEXT_RUNTIME: "nodejs",
        NODE_ENV: "development",
        ENABLE_LOCAL_WORKER: "true",
      }),
    ).toBe(true);
  });

  it.each([
    {
      NEXT_RUNTIME: "edge",
      NODE_ENV: "development",
      ENABLE_LOCAL_WORKER: "true",
    },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      ENABLE_LOCAL_WORKER: "true",
    },
    // The default (no ENABLE_LOCAL_WORKER at all) must NOT start it — this is
    // the whole point of the opt-in flip, and the exact case that let a
    // stale local dev process silently process real production jobs.
    { NEXT_RUNTIME: "nodejs", NODE_ENV: "development" },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "development",
      ENABLE_LOCAL_WORKER: "false",
    },
  ])("does not start for %o", (env) => {
    expect(shouldStartLocalWorker(env)).toBe(false);
  });
});
