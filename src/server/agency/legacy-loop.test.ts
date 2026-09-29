import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLegacyUnitEnabled,
  legacyAgencyLoopMode,
} from "@/server/agency/legacy-loop";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Generators create new legacy pipeline work; drainers finish rows already in
// flight (see legacy-loop.ts).
const GENERATORS = [
  "signal-scans",
  "council-evaluation",
  "director-decisions",
  "measurement-planning",
];
const DRAINERS = [
  "handoff-progression",
  "work-plan-stale-sweep",
  "measurement-checks",
  "learning",
  "strategy-synthesis",
  "work-plan-progression",
  "work-plan-terminal",
  "handoff-close-out",
  "measurement-check-result",
  "measurement-check-terminal",
];
// Real product features and the light intelligence chain: never gated.
const ALWAYS_ON = [
  "agency-loop-heartbeat",
  "meta-ads-performance-scan",
  "google-analytics-scan",
  "signal-processing",
  "insight-synthesis",
  "opportunity-evaluation",
  "telegram-approval-polling",
  "meta-adset-chain",
  "meta-campaign-chain",
  "creative-publish-completion",
  "some-future-unlisted-step",
];

describe("legacyAgencyLoopMode", () => {
  it("defaults to on when unset", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "");
    delete process.env.LEGACY_AGENCY_LOOP;
    expect(legacyAgencyLoopMode()).toBe("on");
  });

  it("reads drain and off, ignoring case and whitespace", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", " Drain ");
    expect(legacyAgencyLoopMode()).toBe("drain");
    vi.stubEnv("LEGACY_AGENCY_LOOP", "OFF");
    expect(legacyAgencyLoopMode()).toBe("off");
  });

  it("falls back to on for an unknown value, so a typo never switches the loop off", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "disabled");
    expect(legacyAgencyLoopMode()).toBe("on");
  });
});

describe("isLegacyUnitEnabled", () => {
  it("runs everything in on mode", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "on");
    for (const name of [...GENERATORS, ...DRAINERS, ...ALWAYS_ON]) {
      expect(isLegacyUnitEnabled(name), name).toBe(true);
    }
  });

  it("stops generators but keeps drainers in drain mode", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "drain");
    for (const name of GENERATORS) {
      expect(isLegacyUnitEnabled(name), name).toBe(false);
    }
    for (const name of [...DRAINERS, ...ALWAYS_ON]) {
      expect(isLegacyUnitEnabled(name), name).toBe(true);
    }
  });

  it("stops generators and drainers in off mode, but never the product features", () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    for (const name of [...GENERATORS, ...DRAINERS]) {
      expect(isLegacyUnitEnabled(name), name).toBe(false);
    }
    for (const name of ALWAYS_ON) {
      expect(isLegacyUnitEnabled(name), name).toBe(true);
    }
  });
});
