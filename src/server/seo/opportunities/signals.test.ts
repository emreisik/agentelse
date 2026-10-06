import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yalnız bu dönemin (haftalık anahtar ya da açık
// aylık SO3 satırı) açık, gölge olmayan, sinyale değer ve signalId'siz
// bulguları okunur; dönem başına bu dönem için açılmış sinyaller dahil en çok
// 3 sinyal, önceki haftadan taşınan sinyaller sınıra sayılmaz; externalRef bulgu kimliğini taşıyan uygulama adresidir;
// başlık ve özet rakam, sorgu ya da yol taşımaz; payload linkId içerir.

const mocks = vi.hoisted(() => ({
  signalCount: vi.fn(),
  findMany: vi.fn(),
  brand: vi.fn(),
  ingestRaw: vi.fn(),
  setFindingOutputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoFinding: { findMany: mocks.findMany },
    signal: { count: mocks.signalCount },
    brand: { findFirst: mocks.brand },
  },
}));
vi.mock("@/server/agency/signals/signal-universe", () => ({
  SignalUniverse: { ingestRaw: mocks.ingestRaw },
}));
vi.mock("./findings-store", () => ({
  setFindingOutputs: mocks.setFindingOutputs,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));

import {
  ingestOpportunitySignals,
  opportunitySignalRef,
  SIGNALS_PER_WEEK,
} from "./signals";

const LINK = { id: "link-1", projectId: "p1", workspaceId: "ws1" };
const PERIOD = "W:2026-09-27";
const NOW = new Date("2026-10-01T12:00:00Z");

const ROWS = [
  { id: "f1", ruleKey: "SO3_CONTENT_DECAY", confidence: "SIGNIFICANT" },
  { id: "f2", ruleKey: "SO6_RISING_QUERY", confidence: "DIRECTIONAL" },
  { id: "f3", ruleKey: "SO13_INTERNATIONAL", confidence: "DIRECTIONAL" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signalCount.mockResolvedValue(0);
  mocks.findMany.mockImplementation(async (args: { take: number }) =>
    ROWS.slice(0, args.take),
  );
  mocks.brand.mockResolvedValue({ id: "b1" });
  let n = 0;
  mocks.ingestRaw.mockImplementation(async () => ({
    duplicate: false,
    signal: { id: `s${++n}` },
  }));
  mocks.setFindingOutputs.mockResolvedValue(undefined);
});

describe("opportunitySignalRef", () => {
  it("is the dated in-app link of the finding", () => {
    expect(opportunitySignalRef("p1", "f1")).toBe(
      "https://app.example.com/projects/p1/arama?opportunity=f1#opportunities",
    );
  });
});

describe("ingestOpportunitySignals", () => {
  it("reads only signal-worthy open findings of the period without a signal", async () => {
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(3);
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      linkId: "link-1",
      OR: [{ periodKey: PERIOD }, { periodKey: { startsWith: "M:" } }],
      status: "OPEN",
      shadow: false,
      signalWorthy: true,
      signalId: null,
    });
    expect(where.ruleKey.in).not.toContain("SO1_STRIKING_DISTANCE");
    expect(where.ruleKey.in).toContain("SO3_CONTENT_DECAY");
    expect(mocks.setFindingOutputs).toHaveBeenCalledWith("f1", {
      signalId: "s1",
    });
  });

  it("counts this period's existing signals against the cap of 3", async () => {
    mocks.signalCount.mockResolvedValueOnce(2);
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(1);
    expect(mocks.findMany.mock.calls[0]![0].take).toBe(1);
    expect(mocks.signalCount).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        source: "search-console-opportunities",
        AND: [
          { payload: { path: ["linkId"], equals: "link-1" } },
          { payload: { path: ["periodKey"], equals: PERIOD } },
        ],
      },
    });

    mocks.signalCount.mockResolvedValueOnce(SIGNALS_PER_WEEK);
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(0);
    expect(mocks.ingestRaw).toHaveBeenCalledTimes(1);
  });

  it("does not count carried-forward signals against the cap", async () => {
    // Önceki haftalardan taşınan 3 bulgu signalId taşır ama bu dönemin
    // sinyali değildir: sayım Signal payload.periodKey'e bakar, bulgulara
    // değil; yeni bir SO3 (aylık) satırı yine sinyal olur.
    mocks.findMany.mockResolvedValueOnce([
      { id: "f9", ruleKey: "SO3_CONTENT_DECAY", confidence: "DIRECTIONAL" },
    ]);
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(1);
    expect(mocks.findMany.mock.calls[0]![0].take).toBe(SIGNALS_PER_WEEK);
    expect(mocks.ingestRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          findingId: "f9",
          ruleKey: "SO3_CONTENT_DECAY",
          periodKey: PERIOD,
        }),
      }),
    );
    expect(mocks.setFindingOutputs).toHaveBeenCalledWith("f9", {
      signalId: "s1",
    });
  });

  it("sends generic text, an in-app ref and the link in the payload", async () => {
    await ingestOpportunitySignals({ link: LINK, periodKey: PERIOD, now: NOW });
    expect(mocks.ingestRaw).toHaveBeenCalledTimes(3);
    for (const [call] of mocks.ingestRaw.mock.calls) {
      expect(call).toMatchObject({
        workspaceId: "ws1",
        projectId: "p1",
        brandId: "b1",
        source: "search-console-opportunities",
        category: "SEO",
        occurredAt: NOW,
        payload: { linkId: "link-1", periodKey: PERIOD },
      });
      expect(call.externalRef).toMatch(
        /^https:\/\/app\.example\.com\/projects\/p1\/arama\?opportunity=f\d#opportunities$/,
      );
      expect(call.externalRef).toContain(call.payload.findingId);
      for (const text of [call.title, call.summary]) {
        expect(text).not.toMatch(/\d/);
        expect(text).not.toMatch(/\/|http|"/);
      }
    }
    expect(mocks.ingestRaw.mock.calls[0]![0].reliability).toBe(1);
    expect(mocks.ingestRaw.mock.calls[1]![0].reliability).toBe(0.6);
  });

  it("links a duplicate to its existing signal without counting it", async () => {
    mocks.ingestRaw.mockResolvedValueOnce({
      duplicate: true,
      existingId: "old",
    });
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(2);
    expect(mocks.setFindingOutputs).toHaveBeenCalledWith("f1", {
      signalId: "old",
    });
  });

  it("does nothing without a default brand", async () => {
    mocks.brand.mockResolvedValueOnce(null);
    expect(
      await ingestOpportunitySignals({
        link: LINK,
        periodKey: PERIOD,
        now: NOW,
      }),
    ).toBe(0);
    expect(mocks.ingestRaw).not.toHaveBeenCalled();
  });
});
