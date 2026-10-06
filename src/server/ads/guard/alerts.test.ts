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

import { SEARCH_TELEGRAM_FALLBACK } from "@/lib/seo/health/alert-kinds";

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

  it("notifyIfDue never sends site alerts to the operator", async () => {
    const siteInput = {
      ...input,
      kind: "GA_MH1",
      dedupeKey: "ga4:GA_MH1:l1",
      source: "GA4",
    };
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "a9", ...siteInput, status: "OPEN" });
    await AdsAlerts.raise(siteInput, now);
    expect(mocks.upsert.mock.calls[0]![0].create.source).toBe("GA4");
    expect(mocks.telegram).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("a critical GSC alert never reaches Telegram", async () => {
    const gscInput = {
      ...input,
      kind: "GSC_SEARCH_DROP",
      dedupeKey: "gsc:GSC_SEARCH_DROP",
      source: "GSC",
    };
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "a10", ...gscInput, status: "OPEN" });
    await AdsAlerts.raise(gscInput, now);
    expect(mocks.telegram).not.toHaveBeenCalled();
  });
});

describe("AdsAlerts.listOpen", () => {
  it("listOpen only returns Meta alerts by default", async () => {
    mocks.findMany.mockResolvedValue([]);
    await AdsAlerts.listOpen("p1");
    expect(mocks.findMany.mock.calls.at(-1)![0].where.source).toBeNull();
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
    // Ads bekçisi site uyarılarını kapatmaz.
    expect(mocks.findMany.mock.calls.at(-1)![0].where.source).toBeNull();
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

  it("telegramTextFor links GA alerts without numbers", () => {
    vi.stubEnv("GA_WEBSITE_PAGE", "true");
    try {
      const text = telegramTextFor({
        kind: "GA_MH1",
        projectName: "Acme",
        projectId: "p1",
        source: "GA4",
      });
      expect(text).toContain("/projects/p1/site");
      expect(text.replace(/https:\/\/\S+/g, "")).not.toMatch(/\d/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("search alerts carry no Google findings, numbers, queries or URLs, only the Search page link", () => {
    const seo = telegramTextFor({
      kind: "SEO_KEY_PAGE_NOINDEX",
      projectName: "A&B",
      projectId: "proj",
      source: "SEO",
    });
    expect(seo).toContain("Search alert for A&amp;B: a key page is set to noindex.");
    expect(seo).toContain("/projects/proj/arama#health");
    const withoutLink = seo.replace(/https:\/\/\S+/g, "");
    expect(withoutLink).not.toMatch(/\d/);
    expect(withoutLink).not.toContain("http");

    const gsc = telegramTextFor({
      kind: "GSC_SEARCH_DROP",
      projectName: "A&B",
      projectId: "proj",
      source: "GSC",
    });
    expect(gsc).toContain(SEARCH_TELEGRAM_FALLBACK);
    expect(gsc).not.toContain("dropped");

    expect(
      telegramTextFor({
        kind: "SEO_NOT_A_KIND",
        projectName: "A&B",
        projectId: "proj",
        source: "SEO",
      }),
    ).toContain(SEARCH_TELEGRAM_FALLBACK);
  });
});
