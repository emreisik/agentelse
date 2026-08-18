import { describe, expect, it } from "vitest";

import { shouldStartLocalWorker } from "./local-worker-policy";

describe("local worker startup policy", () => {
  it("starts only in the Node.js development runtime", () => {
    expect(
      shouldStartLocalWorker({
        NEXT_RUNTIME: "nodejs",
        NODE_ENV: "development",
      }),
    ).toBe(true);
  });

  it.each([
    { NEXT_RUNTIME: "edge", NODE_ENV: "development" },
    { NEXT_RUNTIME: "nodejs", NODE_ENV: "production" },
    {
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "development",
      DISABLE_LOCAL_WORKER: "true",
    },
  ])("does not start for %o", (env) => {
    expect(shouldStartLocalWorker(env)).toBe(false);
  });
});
