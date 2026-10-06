import { beforeEach, describe, expect, it, vi } from "vitest";

import { GA_REPORT_RETENTION_DAYS } from "./retention";

// Bu dosyanın kanıtladığı: kritik uyarı kartı taraması, kartların saklama
// süresinden (95 gün) eski uyarıları almaz; böylece saklamanın sildiği kart
// uyarı açık kaldıkça yeniden yazılmaz.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { adsAlert: { findMany: mocks.findMany } },
}));
vi.mock("./inputs", () => ({
  loadPulseInput: vi.fn(),
  reportLinkInfo: vi.fn(),
}));
vi.mock("./website-chat", () => ({
  postToWebsiteChat: vi.fn(),
  stepResultOf: vi.fn(),
  websiteReportExists: vi.fn(),
}));
vi.mock("./retention", () => ({
  GA_REPORT_RETENTION_DAYS: { alert: 95 },
}));

const { GaPulse } = await import("./pulse");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
});

describe("GaPulse.postAlertCards", () => {
  it("skips alerts first seen before the alert card retention", async () => {
    const now = new Date("2026-10-07T07:00:00.000Z");
    await GaPulse.postAlertCards(
      { projectId: "p1", now } as never,
      new Date("2026-10-06T07:00:00.000Z"),
    );
    const where = mocks.findMany.mock.calls[0]![0].where as {
      firstSeenAt: { gt: Date };
    };
    expect(where.firstSeenAt.gt.toISOString()).toBe(
      new Date(
        now.getTime() - GA_REPORT_RETENTION_DAYS.alert * 86_400_000,
      ).toISOString(),
    );
  });
});
