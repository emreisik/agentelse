import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  projectFind: vi.fn(),
  telegram: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsAlert: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      update: mocks.update,
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
    },
    project: { findUnique: mocks.projectFind },
  },
}));
vi.mock("@/server/notifications/telegram.service", () => ({
  sendTelegramMessage: mocks.telegram,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example"),
}));

import { AdsAlerts, telegramTextFor } from "./alerts";

const now = new Date("2026-10-06T10:00:00Z");
const input = {
  workspaceId: "w1",
  projectId: "p1",
  kind: "RUNAWAY_SPEND",
  severity: "CRITICAL" as const,
  dedupeKey: "RUNAWAY_SPEND:c1",
  title: "Spending above plan: Leads",
};

describe("AdsAlerts.raise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectFind.mockResolvedValue({ name: "Acme" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("opens a new alert and notifies a critical one once", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "a1", ...input, status: "OPEN", projectId: "p1" });
    await AdsAlerts.raise(input, now);
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.telegram).toHaveBeenCalledOnce();
    // Meta data (campaign name, amounts) never goes to Telegram.
    expect(mocks.telegram.mock.calls[0]![0]).not.toContain("Leads");
  });

  it("does not notify again while the CAS claim fails", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "a1", ...input, status: "OPEN" });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await AdsAlerts.raise(input, now);
    expect(mocks.telegram).not.toHaveBeenCalled();
  });

  it("reopens a resolved alert and counts the occurrence", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "a1",
      ...input,
      severity: "CRITICAL",
      status: "RESOLVED",
      mutedUntil: null,
    });
    mocks.update.mockResolvedValue({ id: "a1", ...input, status: "OPEN" });
    await AdsAlerts.raise(input, now);
    expect(mocks.update.mock.calls[0]![0].data).toMatchObject({
      status: "OPEN",
      resolvedAt: null,
      occurrences: { increment: 1 },
    });
  });

  it("keeps a muted alert muted", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "a1",
      ...input,
      status: "MUTED",
      mutedUntil: new Date("2026-10-10T00:00:00Z"),
    });
    mocks.update.mockResolvedValue({ id: "a1", ...input, status: "MUTED" });
    await AdsAlerts.raise(input, now);
    expect(mocks.update.mock.calls[0]![0].data.status).toBeUndefined();
    expect(mocks.telegram).not.toHaveBeenCalled();
  });
});

describe("AdsAlerts.resolveMissing", () => {
  it("resolves only alerts whose condition is gone", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a1", dedupeKey: "k1" },
      { id: "a2", dedupeKey: "k2" },
    ]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const count = await AdsAlerts.resolveMissing(
      { projectId: "p1", kinds: ["NO_DELIVERY"], stillOpen: new Set(["k1"]) },
      now,
    );
    expect(count).toBe(1);
    expect(mocks.updateMany.mock.calls.at(-1)![0].where).toEqual({ id: { in: ["a2"] } });
  });
});

describe("telegramTextFor", () => {
  it("names only Agentelse's own data", () => {
    expect(
      telegramTextFor({ kind: "PAYMENT_ISSUE", projectName: "A&B", projectId: "p1" }),
    ).toBe(
      "Ads alert for A&amp;B: the ad account has a payment issue. Open Agentelse: https://app.example/projects/p1/ads",
    );
  });
});
