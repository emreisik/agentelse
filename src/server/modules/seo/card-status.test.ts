import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoCardRead } from "@/server/modules/seo/card";
import { actionViewFixture } from "@/lib/seo/actions/test-support";
import type {
  SeoActionProposalStored,
  SeoEvaluation,
} from "@/lib/seo/actions/types";

// Kart durumu: takvim parçası, eylemin durumu/sonucu ve konu önerisi. Kart
// okuyucusu, takvim ve eylem deposu sahte; metin kaynakları (copy) gerçek.

const mocks = vi.hoisted(() => ({
  readSeoCard: vi.fn(),
  seoPieceStatus: vi.fn(),
  creativeFindFirst: vi.fn(),
  getAction: vi.fn(),
  actionForCard: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { findFirst: mocks.creativeFindFirst } },
}));
vi.mock("@/server/modules/seo/card", () => ({ readSeoCard: mocks.readSeoCard }));
vi.mock("@/server/modules/seo/calendar", () => ({
  seoPieceStatus: mocks.seoPieceStatus,
}));
vi.mock("@/server/seo/actions/store", () => ({
  getAction: mocks.getAction,
  actionForCard: mocks.actionForCard,
}));

import { loadSeoCardStatus } from "./card-status";

const PROJECT = "p1";
const COMMAND = "c1";

function card(
  state: SeoCardRead["state"],
  step: SeoCardRead["step"] = "deliver",
): SeoCardRead {
  return {
    card: {
      kind: "module-flow",
      module: "seo",
      title: "SEO Manager",
      step,
      data: {},
    },
    step,
    state,
    workId: "w1",
  };
}

function articleProposal(
  kind: "NEW_CONTENT" | "LOCALIZE",
  primaryKeyword: string | null,
): SeoActionProposalStored {
  return {
    v: 1,
    kind,
    title: "A new page",
    primaryKeyword,
    language: "en",
    liveUrl: null,
    note: null,
    alert: null,
  };
}

const DELIVERY = {
  postId: "post1",
  creativeId: "cr1",
  scheduledFor: "2026-10-09T07:00:00.000Z",
  timezone: "Europe/Istanbul",
};

const EVALUATION: SeoEvaluation = {
  v: 1,
  method: "DID",
  metric: "clicks",
  anchorDay: "2026-09-01",
  preWeeks: [],
  postWeeks: [],
  effect: 0.2,
  low: 0.1,
  high: 0.3,
  controls: 5,
  yoyAdjusted: false,
  treated: null,
  control: null,
  yoy: null,
  updates: [],
  truncated: false,
  cwv: null,
  sitemap: null,
  reason: null,
  outcome: "WORKED",
  confidence: "SIGNIFICANT",
  evaluatedAt: "2026-10-01T00:00:00.000Z",
};

const originalActions = process.env.SEO_ACTIONS;
const originalHealth = process.env.SEO_HEALTH;
const originalCrawl = process.env.SEO_CRAWL;

function loopOn(): void {
  process.env.SEO_ACTIONS = "true";
  process.env.SEO_HEALTH = "true";
  process.env.SEO_CRAWL = "true";
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  loopOn();
  mocks.getAction.mockResolvedValue(null);
  mocks.actionForCard.mockResolvedValue(null);
  mocks.seoPieceStatus.mockResolvedValue(null);
  mocks.creativeFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  restore("SEO_ACTIONS", originalActions);
  restore("SEO_HEALTH", originalHealth);
  restore("SEO_CRAWL", originalCrawl);
});

describe("loadSeoCardStatus", () => {
  it("kart yoksa null döner", async () => {
    mocks.readSeoCard.mockResolvedValue(null);
    expect(await loadSeoCardStatus(PROJECT, COMMAND)).toBeNull();
  });

  it("boş kartta parça, eylem ve öneri yoktur", async () => {
    mocks.readSeoCard.mockResolvedValue(card({}));
    expect(await loadSeoCardStatus(PROJECT, COMMAND)).toEqual({
      piece: null,
      action: null,
      suggestion: null,
      removed: false,
    });
  });

  it("takvimdeki parça: zamanlı, yayımlanmış ve kaldırılmış", async () => {
    mocks.readSeoCard.mockResolvedValue(card({ delivery: DELIVERY }));

    mocks.seoPieceStatus.mockResolvedValueOnce("APPROVED");
    mocks.creativeFindFirst.mockResolvedValueOnce({
      scheduledFor: new Date("2026-10-10T07:00:00.000Z"),
    });
    const scheduled = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(scheduled?.piece).toMatchObject({
      status: "APPROVED",
      at: "2026-10-10T07:00:00.000Z",
    });
    expect(scheduled?.piece?.label).toMatch(/^On calendar for /);
    expect(scheduled?.piece?.label).toContain("Sat 10 Oct");

    mocks.seoPieceStatus.mockResolvedValueOnce("PUBLISHED");
    mocks.creativeFindFirst.mockResolvedValueOnce({
      scheduledFor: new Date("2026-10-10T07:00:00.000Z"),
    });
    const published = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(published?.piece).toMatchObject({ status: "PUBLISHED", label: "Published" });

    mocks.seoPieceStatus.mockResolvedValueOnce(null);
    const removed = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(removed?.piece).toEqual({
      status: "REMOVED",
      label: "Removed from calendar",
      at: null,
    });
  });

  it("sonuç başlığı yalnız değerlendirilmiş eylemde gelir", async () => {
    mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }));

    mocks.getAction.mockResolvedValueOnce(
      actionViewFixture({ id: "a1", status: "EVALUATING", evaluation: null }),
    );
    const measuring = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(measuring?.action).toMatchObject({
      status: "EVALUATING",
      statusLabel: "Measuring",
      headline: null,
      detail: null,
    });

    mocks.getAction.mockResolvedValueOnce(
      actionViewFixture({
        id: "a1",
        status: "WORKED",
        evaluation: EVALUATION,
        outcome: "WORKED",
        evaluateAfter: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
    const worked = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(worked?.action?.headline).toBeTruthy();
    expect(worked?.action?.statusLabel).toBe("Worked");
    expect(worked?.action?.evaluateAfter).toBe("2026-10-01T00:00:00.000Z");
  });

  it("sorulmuş (askedAt) uygulanmış eylem soru metnini taşır", async () => {
    mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }));
    mocks.getAction.mockResolvedValue(
      actionViewFixture({
        id: "a1",
        status: "APPLIED",
        askedAt: new Date("2026-09-20T00:00:00.000Z"),
      }),
    );
    const asked = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(asked?.action?.ask).toEqual(expect.any(String));
    expect(asked?.action?.can).toEqual({
      confirmLive: true,
      checkNow: true,
      undo: true,
    });

    mocks.getAction.mockResolvedValue(
      actionViewFixture({ id: "a1", status: "APPLIED", askedAt: null }),
    );
    expect((await loadSeoCardStatus(PROJECT, COMMAND))?.action?.ask).toBeNull();
  });

  it("actionId yoksa kartın eylemini kart kimliğiyle bulur", async () => {
    mocks.readSeoCard.mockResolvedValue(card({}));
    mocks.actionForCard.mockResolvedValue(
      actionViewFixture({ id: "a9", status: "VERIFIED" }),
    );
    const status = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(mocks.actionForCard).toHaveBeenCalledWith(PROJECT, COMMAND);
    expect(status?.action).toMatchObject({
      id: "a9",
      can: { confirmLive: false, checkNow: true, undo: false },
    });
  });

  it("removed: actionId var ama satır yok", async () => {
    mocks.readSeoCard.mockResolvedValue(card({ actionId: "gone" }));
    const status = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(status).toMatchObject({ action: null, removed: true });
  });

  it("eylem döngüsü kapalıyken eylem okunmaz ve removed false kalır", async () => {
    delete process.env.SEO_CRAWL;
    mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }));
    const status = await loadSeoCardStatus(PROJECT, COMMAND);
    expect(mocks.getAction).not.toHaveBeenCalled();
    expect(status).toMatchObject({ action: null, removed: false });
  });

  describe("konu önerisi", () => {
    const newContent = (overrides = {}) =>
      actionViewFixture({
        id: "a1",
        kind: "NEW_CONTENT",
        status: "ACCEPTED",
        proposal: articleProposal("NEW_CONTENT", "blue widgets"),
        ...overrides,
      });

    it("açık NEW_CONTENT eylemi, Brief'te, boş konuda önerilir", async () => {
      mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }, "brief"));
      mocks.getAction.mockResolvedValue(newContent());
      const status = await loadSeoCardStatus(PROJECT, COMMAND);
      expect(status?.suggestion).toEqual({ topic: "blue widgets" });
    });

    it("LOCALIZE için de önerilir", async () => {
      mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }, "brief"));
      mocks.getAction.mockResolvedValue(
        actionViewFixture({
          id: "a1",
          kind: "LOCALIZE",
          status: "PROPOSED",
          proposal: articleProposal("LOCALIZE", "mavi aletler"),
        }),
      );
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toEqual({
        topic: "mavi aletler",
      });
    });

    it("konu doldurulmuşsa ya da Brief'ten ilerlenmişse önerilmez", async () => {
      mocks.getAction.mockResolvedValue(newContent());
      mocks.readSeoCard.mockResolvedValue(
        card(
          {
            actionId: "a1",
            brief: { topic: "My topic", siteUrl: "", language: "en", audience: "" },
          },
          "brief",
        ),
      );
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toBeNull();

      mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }, "plan"));
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toBeNull();
    });

    it("açık olmayan ya da başka türdeki eylemde önerilmez", async () => {
      mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }, "brief"));
      mocks.getAction.mockResolvedValue(newContent({ status: "WORKED" }));
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toBeNull();

      mocks.getAction.mockResolvedValue(
        actionViewFixture({ id: "a1", kind: "TITLE_META", status: "PROPOSED" }),
      );
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toBeNull();
    });

    it("anahtar kelime yoksa önerilmez", async () => {
      mocks.readSeoCard.mockResolvedValue(card({ actionId: "a1" }, "brief"));
      mocks.getAction.mockResolvedValue(
        newContent({
          proposal: articleProposal("NEW_CONTENT", null),
        }),
      );
      expect((await loadSeoCardStatus(PROJECT, COMMAND))?.suggestion).toBeNull();
    });
  });
});
