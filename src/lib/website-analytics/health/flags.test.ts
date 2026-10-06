import { afterEach, describe, expect, it, vi } from "vitest";

import { gaHealthEnabled } from "./flags";

// GA_HEALTH çağrı anında okunur, yalnız "true" açar ve GA_SYNC ister.

describe("gaHealthEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires GA_SYNC", () => {
    vi.stubEnv("GA_HEALTH", "true");
    vi.stubEnv("GA_SYNC", "");
    expect(gaHealthEnabled()).toBe(false);
    vi.stubEnv("GA_SYNC", "true");
    expect(gaHealthEnabled()).toBe(true);
  });

  it("only 'true' turns it on", () => {
    vi.stubEnv("GA_SYNC", "true");
    for (const value of ["", "1", "TRUE", "false", "yes"]) {
      vi.stubEnv("GA_HEALTH", value);
      expect(gaHealthEnabled()).toBe(false);
    }
    vi.stubEnv("GA_HEALTH", "true");
    expect(gaHealthEnabled()).toBe(true);
  });
});
