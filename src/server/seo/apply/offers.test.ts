import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F8 "Apply with approval" teklifleri): bayrak
// kapalıyken hiçbir okuma yoktur; açıkken tek CmsSite sorgusu yapılır (bağlantı
// yok ya da sağlıksızsa teklif yok); eylemi olmayan INTERNAL_LINKS bulgusu
// findingId ile "ready" olur; yalnız karşılanmamış bağlantılar listelenir;
// metni olmayan TITLE_META teklifi yoktur; açık değişiklik "pending", doğrulanmış
// değişiklik "applied" olur.

const mocks = vi.hoisted(() => ({
  seoChangeFindMany: vi.fn(),
  loadCmsSite: vi.fn(),
  listApplyCandidates: vi.fn(),
  remainingLinksOf: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { seoChange: { findMany: mocks.seoChangeFindMany } },
}));
vi.mock("@/server/integrations/wordpress/connection", () => ({
  loadCmsSite: mocks.loadCmsSite,
}));
vi.mock("./action-link", () => ({
  listApplyCandidates: mocks.listApplyCandidates,
  remainingLinksOf: mocks.remainingLinksOf,
}));

import {
  loadApplyOffersForActions,
  loadApplyOffersForFindings,
  loadApplyReady,
} from "./offers";

const NAMES = [
  "SEO_APPLY",
  "SEO_HEALTH",
  "SEO_CRAWL",
  "SEO_ACTIONS",
  "AGENTELSE_PROVIDER_MODE",
] as const;
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

function env(on: boolean): void {
  const value = on ? "true" : "";
  process.env.SEO_APPLY = value;
  process.env.SEO_HEALTH = value;
  process.env.SEO_CRAWL = value;
  process.env.SEO_ACTIONS = value;
  process.env.AGENTELSE_PROVIDER_MODE = "";
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    actionId: "act1",
    findingId: "f1",
    kind: "TITLE_META",
    status: "ACCEPTED",
    targetUrl: "https://example.com/pricing",
    after: { title: "New", metaDescription: "Desc" },
    links: [],
    ...overrides,
  };
}

const LINKS = [
  { fromUrl: "https://example.com/a", toUrl: "https://example.com/x", anchor: "x" },
  { fromUrl: "https://example.com/b", toUrl: "https://example.com/y", anchor: "y" },
];

beforeEach(() => {
  vi.clearAllMocks();
  env(true);
  mocks.loadCmsSite.mockResolvedValue({ isMock: false, health: "OK" });
  mocks.seoChangeFindMany.mockResolvedValue([]);
  mocks.listApplyCandidates.mockResolvedValue([]);
  mocks.remainingLinksOf.mockResolvedValue([]);
});

afterEach(() => {
  for (const name of NAMES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

describe("flag off", () => {
  it("reads nothing at all", async () => {
    env(false);
    expect(await loadApplyReady("p1")).toBe(false);
    expect(
      await loadApplyOffersForFindings("p1", [{ id: "f1", actionKind: "TITLE_META" }]),
    ).toEqual({});
    expect(await loadApplyOffersForActions("p1", ["act1"])).toEqual({});
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
    expect(mocks.listApplyCandidates).not.toHaveBeenCalled();
    expect(mocks.seoChangeFindMany).not.toHaveBeenCalled();
    expect(mocks.remainingLinksOf).not.toHaveBeenCalled();
  });
});

describe("loadApplyReady", () => {
  it("makes exactly one CmsSite read and needs a healthy site", async () => {
    expect(await loadApplyReady("p1")).toBe(true);
    expect(mocks.loadCmsSite).toHaveBeenCalledTimes(1);
    expect(mocks.seoChangeFindMany).not.toHaveBeenCalled();

    mocks.loadCmsSite.mockResolvedValue({ isMock: false, health: "LIMITED" });
    expect(await loadApplyReady("p1")).toBe(true);
    mocks.loadCmsSite.mockResolvedValue({ isMock: false, health: "AUTH" });
    expect(await loadApplyReady("p1")).toBe(false);
    mocks.loadCmsSite.mockResolvedValue(null);
    expect(await loadApplyReady("p1")).toBe(false);
  });

  it("does not trust a site of the other process mode", async () => {
    mocks.loadCmsSite.mockResolvedValue({ isMock: true, health: "OK" });
    expect(await loadApplyReady("p1")).toBe(false);
  });

  it("is false when the read fails", async () => {
    mocks.loadCmsSite.mockRejectedValue(new Error("db down"));
    expect(await loadApplyReady("p1")).toBe(false);
  });
});

describe("loadApplyOffersForFindings", () => {
  it("returns nothing without a healthy site, and reads no candidates", async () => {
    mocks.loadCmsSite.mockResolvedValue(null);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "INTERNAL_LINKS" },
    ]);
    expect(result).toEqual({});
    expect(mocks.loadCmsSite).toHaveBeenCalledTimes(1);
    expect(mocks.listApplyCandidates).not.toHaveBeenCalled();
  });

  it("returns nothing while the SC-F6 loop is off", async () => {
    process.env.SEO_ACTIONS = "";
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "INTERNAL_LINKS" },
    ]);
    expect(result).toEqual({});
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
  });

  it("ignores finding kinds that cannot be applied", async () => {
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TECHNICAL_FIX" },
    ]);
    expect(result).toEqual({});
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
  });

  it("offers an internal-links finding without an action as ready with its finding id", async () => {
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "INTERNAL_LINKS" },
      { id: "f2", actionKind: "TITLE_META" },
    ]);
    expect(result).toEqual({
      f1: {
        state: "ready",
        changeId: null,
        actionId: null,
        findingId: "f1",
        kind: "INTERNAL_LINKS",
        links: [],
        hint: null,
      },
    });
  });

  it("gives no offer for a title/description action without text", async () => {
    mocks.listApplyCandidates.mockResolvedValue([candidate({ after: null })]);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(result).toEqual({});
  });

  it("offers a title/description action that has text", async () => {
    mocks.listApplyCandidates.mockResolvedValue([candidate()]);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(result.f1).toMatchObject({
      state: "ready",
      actionId: "act1",
      findingId: "f1",
      kind: "TITLE_META",
    });
  });

  it("lists only the links not yet covered", async () => {
    mocks.listApplyCandidates.mockResolvedValue([
      candidate({ kind: "INTERNAL_LINKS", after: null, links: LINKS }),
    ]);
    mocks.remainingLinksOf.mockResolvedValue([LINKS[1]]);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "INTERNAL_LINKS" },
    ]);
    expect(result.f1).toMatchObject({ state: "ready", links: [LINKS[1]] });
    expect(mocks.remainingLinksOf).toHaveBeenCalledWith("p1", "act1");
  });

  it("shows pending for an open change and applied for a verified one", async () => {
    mocks.listApplyCandidates.mockResolvedValue([candidate()]);
    mocks.seoChangeFindMany.mockResolvedValue([
      { id: "c1", seoActionId: "act1", openKey: "k", status: "PROPOSED" },
    ]);
    const pending = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(pending.f1).toMatchObject({ state: "pending", changeId: "c1" });

    mocks.seoChangeFindMany.mockResolvedValue([
      { id: "c2", seoActionId: "act1", openKey: null, status: "VERIFIED" },
    ]);
    const applied = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(applied.f1).toMatchObject({ state: "applied", changeId: "c2" });
  });

  it("marks internal links applied only when every link is covered by a verified change", async () => {
    mocks.listApplyCandidates.mockResolvedValue([
      candidate({ kind: "INTERNAL_LINKS", after: null, status: "APPLIED", links: LINKS }),
    ]);
    mocks.remainingLinksOf.mockResolvedValue([]);
    mocks.seoChangeFindMany.mockResolvedValue([
      { id: "c3", seoActionId: "act1", openKey: null, status: "VERIFIED" },
    ]);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "INTERNAL_LINKS" },
    ]);
    expect(result.f1).toMatchObject({ state: "applied", changeId: "c3" });
  });

  it("makes no other offers for closed actions", async () => {
    mocks.listApplyCandidates.mockResolvedValue([candidate({ status: "DISMISSED" })]);
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(result).toEqual({});
  });

  it("returns an empty map when a read fails", async () => {
    mocks.listApplyCandidates.mockRejectedValue(new Error("boom"));
    const result = await loadApplyOffersForFindings("p1", [
      { id: "f1", actionKind: "TITLE_META" },
    ]);
    expect(result).toEqual({});
  });
});

describe("loadApplyOffersForActions", () => {
  it("keys offers by action id and reads one CmsSite row", async () => {
    mocks.listApplyCandidates.mockResolvedValue([
      candidate(),
      candidate({
        actionId: "act2",
        kind: "INTERNAL_LINKS",
        after: null,
        links: LINKS,
      }),
    ]);
    mocks.remainingLinksOf.mockResolvedValue(LINKS);
    const result = await loadApplyOffersForActions("p1", ["act1", "act2"]);
    expect(Object.keys(result).sort()).toEqual(["act1", "act2"]);
    expect(result.act2?.links).toEqual(LINKS);
    expect(mocks.loadCmsSite).toHaveBeenCalledTimes(1);
    expect(mocks.listApplyCandidates).toHaveBeenCalledWith("p1", {
      actionIds: ["act1", "act2"],
    });
  });

  it("does not read when no action ids are given", async () => {
    expect(await loadApplyOffersForActions("p1", [])).toEqual({});
    expect(mocks.loadCmsSite).not.toHaveBeenCalled();
  });
});
