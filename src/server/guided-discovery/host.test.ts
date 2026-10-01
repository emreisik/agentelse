import { describe, expect, it, vi } from "vitest";

import type { DiscoveryView } from "@/lib/guided-discovery/contract";

import type { HostDeps } from "./host";

// The page host never throws and never does more than read.

vi.mock("server-only", () => ({}));
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: () => false,
}));
vi.mock("./service", () => ({ readDiscoveryState: vi.fn() }));

const { loadDiscoveryHost } = await import("./host");

const VIEW: DiscoveryView = {
  rev: "abcdef012345",
  status: "RUNNING",
  stages: {
    site: "running",
    identity: "pending",
    research: "pending",
    profile: "pending",
  },
  identity: null,
  rows: [],
  host: "acme.example",
  failure: null,
  canRetry: false,
  brandName: "Acme",
};

function deps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    enabled: () => true,
    read: vi.fn(async () => ({ view: VIEW, brandName: "Acme" })),
    ...overrides,
  };
}

describe("loadDiscoveryHost", () => {
  it("returns the view, the brand and the request flag", async () => {
    expect(await loadDiscoveryHost("p1", true, deps())).toEqual({
      requested: true,
      view: VIEW,
      brandName: "Acme",
    });
  });

  it("returns a null view when nothing was started yet", async () => {
    const host = await loadDiscoveryHost(
      "p1",
      false,
      deps({ read: async () => ({ view: null, brandName: "Acme" }) }),
    );
    expect(host).toEqual({ requested: false, view: null, brandName: "Acme" });
  });

  it("is absent and reads nothing when the flag is off", async () => {
    const read = vi.fn();
    expect(
      await loadDiscoveryHost("p1", true, deps({ enabled: () => false, read })),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("is absent when the project has no brand", async () => {
    expect(
      await loadDiscoveryHost("p1", true, deps({ read: async () => null })),
    ).toBeUndefined();
  });

  it("never throws: any error means the feature is absent", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = deps({
      read: async () => {
        throw new Error("db down");
      },
    });
    expect(await loadDiscoveryHost("p1", true, failing)).toBeUndefined();
    const throwingFlag = deps({
      enabled: () => {
        throw new Error("env broken");
      },
    });
    expect(await loadDiscoveryHost("p1", true, throwingFlag)).toBeUndefined();
    log.mockRestore();
  });
});
