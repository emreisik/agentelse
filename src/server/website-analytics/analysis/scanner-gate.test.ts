import { beforeEach, describe, expect, it, vi } from "vitest";

import { scannerGaGate } from "./scanner-gate";

// Bu dosyanın kanıtladığı: GA sağlayıcısı yalnız GA_INSIGHTS=on (GA_SYNC
// ile) iken düşer; gölge modda GA_INSIGHTS_PROJECTS projeleri dışarıda
// bırakılır; kapalıyken liste aynen döner.

const PROVIDERS = ["google_analytics", "google_search_console"] as const;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_INSIGHTS_PROJECTS", "");
});

describe("scannerGaGate", () => {
  it("drops the analytics provider when GA_INSIGHTS=on", () => {
    vi.stubEnv("GA_INSIGHTS", "on");
    expect(scannerGaGate(PROVIDERS, "google_analytics")).toEqual({
      providers: ["google_search_console"],
      excludeGaProjectIds: [],
    });
  });

  it("keeps the analytics provider when GA_SYNC is off", () => {
    vi.stubEnv("GA_INSIGHTS", "on");
    vi.stubEnv("GA_SYNC", "false");
    expect(scannerGaGate(PROVIDERS, "google_analytics")).toEqual({
      providers: [...PROVIDERS],
      excludeGaProjectIds: [],
    });
  });

  it("excludes the listed projects in shadow mode", () => {
    vi.stubEnv("GA_INSIGHTS", "shadow");
    vi.stubEnv("GA_INSIGHTS_PROJECTS", "proj-1, proj-2");
    expect(scannerGaGate(PROVIDERS, "google_analytics")).toEqual({
      providers: [...PROVIDERS],
      excludeGaProjectIds: ["proj-1", "proj-2"],
    });
  });

  it("leaves everything unchanged when off", () => {
    vi.stubEnv("GA_INSIGHTS", "off");
    vi.stubEnv("GA_INSIGHTS_PROJECTS", "proj-1");
    expect(scannerGaGate(PROVIDERS, "google_analytics")).toEqual({
      providers: [...PROVIDERS],
      excludeGaProjectIds: [],
    });
  });
});
