import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GeoAuditResult } from "@/lib/seo/geo/types";

// Bu dosyanın kanıtladığı: saveGeoAudit kabul listesini kilit anındaki kopyadan
// değil satırın güncel değerinden alır; denetim sürerken verilen "I decided this"
// kararı kaybolmaz ve puan yeniden hesaplanır.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  rescore: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { seoGeoAudit: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));
vi.mock("@/lib/seo/health-flags", () => ({ seoMockMode: () => true }));
vi.mock("@/lib/seo/geo/evaluate", () => ({ rescore: mocks.rescore }));

const { saveGeoAudit } = await import("./store");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const RESULT = { v: 1, score: 40, checks: [] } as unknown as GeoAuditResult;

function input(acknowledged: ("GEO2" | "GEO9")[]) {
  return {
    siteId: "s1",
    workspaceId: "w1",
    projectId: "p1",
    isMock: true,
    scopeKey: "k",
    result: RESULT,
    recommendations: null,
    acknowledged,
    now: NOW,
    nextAuditAt: NOW,
    lastError: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.upsert.mockResolvedValue({});
  mocks.rescore.mockImplementation((result: GeoAuditResult, ack: string[]) => ({
    ...result,
    score: 40 + ack.length * 10,
  }));
});

describe("saveGeoAudit acknowledged merge", () => {
  it("keeps an acknowledgement given while the audit ran and rescores", async () => {
    mocks.findUnique.mockResolvedValue({
      score: 30,
      auditedAt: NOW,
      result: null,
      acknowledged: ["GEO2"],
    });
    await saveGeoAudit(input([]));
    expect(mocks.rescore).toHaveBeenCalledWith(RESULT, ["GEO2"]);
    const update = mocks.upsert.mock.calls[0]![0].update;
    expect(update.acknowledged).toEqual(["GEO2"]);
    expect(update.score).toBe(50);
  });

  it("does not rescore when the list is unchanged", async () => {
    mocks.findUnique.mockResolvedValue({
      score: 30,
      auditedAt: NOW,
      result: null,
      acknowledged: ["GEO9"],
    });
    await saveGeoAudit(input(["GEO9"]));
    expect(mocks.rescore).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls[0]![0].update.score).toBe(40);
  });
});
