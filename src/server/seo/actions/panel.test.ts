import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actionViewFixture } from "@/lib/seo/actions/test-support";
import type {
  SeoActionStatus,
  SeoActionView,
  SeoEvaluation,
} from "@/lib/seo/actions/types";

// Bu dosyanın kanıtladığı (SC-F6 "Actions & results" verisi): bayrak ya da
// açılış listesi kapalıyken ne eylem deposuna ne veritabanına gidilir; eylemler
// Needs you / In progress / Results gruplarına ayrılır; can bayrakları durumdan
// çıkar; sonuç başlığı ve ayrıntısı şablondur; ?action= satırı vurgulanır;
// teklif satırlarında anahtar kelime ve sorgu dizesi yoktur.

const mocks = vi.hoisted(() => ({
  listActions: vi.fn(),
  primaryGscLink: vi.fn(),
  prisma: { seoAction: { findMany: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/server/seo/actions/store", () => ({
  listActions: mocks.listActions,
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
}));

const { loadSeoActionsPanel, itemOf, cleanPath } = await import("./panel");

const NOW = new Date("2026-10-07T10:00:00.000Z");

function enable() {
  vi.stubEnv("SEO_ACTIONS", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
}

function action(overrides: Partial<SeoActionView> = {}): SeoActionView {
  return actionViewFixture(overrides);
}

function evaluation(overrides: Partial<SeoEvaluation> = {}): SeoEvaluation {
  const window = {
    weeks: 4,
    clicks: 100,
    impressions: 1000,
    ctr: 0.1,
    position: 5,
    ctrAdj: 1,
  };
  return {
    v: 1,
    method: "DID",
    metric: "ctr_adj",
    anchorDay: "2026-09-01",
    preWeeks: [],
    postWeeks: [],
    effect: 0.18,
    low: 0.09,
    high: 0.27,
    controls: 6,
    yoyAdjusted: false,
    treated: { before: window, after: window },
    control: { before: window, after: window },
    yoy: null,
    updates: [],
    truncated: false,
    cwv: null,
    sitemap: null,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

function stubLists(open: SeoActionView[], evaluated: SeoActionView[] = []) {
  mocks.listActions.mockImplementation(
    async (_projectId: string, options: { statuses?: SeoActionStatus[] }) =>
      options.statuses?.includes("PROPOSED") ? open : evaluated,
  );
}

beforeEach(() => {
  enable();
  mocks.primaryGscLink.mockResolvedValue({ id: "link-1", isMock: false });
  stubLists([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("loadSeoActionsPanel gating", () => {
  it("returns null without any query when the loop flag is off", async () => {
    vi.stubEnv("SEO_ACTIONS", "");
    expect(await loadSeoActionsPanel("project-1", { now: NOW })).toBeNull();
    expect(mocks.listActions).not.toHaveBeenCalled();
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();
    expect(mocks.prisma.seoAction.findMany).not.toHaveBeenCalled();
  });

  it("needs the crawler flags too", async () => {
    vi.stubEnv("SEO_CRAWL", "");
    expect(await loadSeoActionsPanel("project-1", { now: NOW })).toBeNull();
    expect(mocks.listActions).not.toHaveBeenCalled();
  });

  it("returns null outside the rollout allow-list", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "someone-else");
    expect(await loadSeoActionsPanel("project-1", { now: NOW })).toBeNull();
    expect(mocks.listActions).not.toHaveBeenCalled();
  });
});

describe("loadSeoActionsPanel grouping", () => {
  it("groups needs-you, in-progress and results", async () => {
    const accepted = action({ id: "a-accepted", status: "ACCEPTED" });
    const asked = action({
      id: "a-asked",
      status: "APPLIED",
      askedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const checking = action({ id: "a-checking", status: "APPLIED" });
    const verified = action({ id: "a-verified", status: "VERIFIED" });
    const measuring = action({
      id: "a-measuring",
      status: "EVALUATING",
      evaluateAfter: new Date("2026-11-03T00:00:00.000Z"),
    });
    const proposedNoCard = action({ id: "a-proposed", status: "PROPOSED" });
    const proposedWithCard = action({
      id: "a-card",
      status: "PROPOSED",
      commandId: "cmd-1",
      workId: "work-1",
    });
    const worked = action({
      id: "a-worked",
      status: "WORKED",
      evaluation: evaluation(),
      outcome: "WORKED",
      evaluatedAt: new Date("2026-10-06T00:00:00.000Z"),
    });
    const didnt = action({
      id: "a-didnt",
      status: "DIDNT",
      evaluation: evaluation({ outcome: "DIDNT", effect: -0.04 }),
      evaluatedAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    const stale = action({
      id: "a-stale",
      status: "WORKED",
      evaluatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    stubLists(
      [
        accepted,
        asked,
        checking,
        verified,
        measuring,
        proposedNoCard,
        proposedWithCard,
      ],
      [didnt, stale, worked],
    );
    const panel = await loadSeoActionsPanel("project-1", { now: NOW });
    expect(panel?.needsYou.map((item) => item.id)).toEqual([
      "a-accepted",
      "a-asked",
    ]);
    expect(panel?.inProgress.map((item) => item.id)).toEqual([
      "a-checking",
      "a-verified",
      "a-measuring",
      "a-proposed",
    ]);
    // Kartı olan öneri kendi kartında sürer; 180 günden eski sonuç düşer.
    expect(panel?.results.map((item) => item.id)).toEqual([
      "a-worked",
      "a-didnt",
    ]);
    expect(panel?.counts).toEqual({
      needsYou: 2,
      inProgress: 4,
      worked: 1,
      didnt: 1,
      inconclusive: 0,
    });
    expect(panel?.searchConnected).toBe(true);
  });

  it("reports a missing search connection", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    const panel = await loadSeoActionsPanel("project-1", { now: NOW });
    expect(panel?.searchConnected).toBe(false);
  });

  it("ignores a link of the other mode", async () => {
    mocks.primaryGscLink.mockResolvedValue({ id: "link-1", isMock: true });
    const panel = await loadSeoActionsPanel("project-1", { now: NOW });
    expect(panel?.searchConnected).toBe(false);
  });

  it("highlights only a well-formed matching id", async () => {
    stubLists([action({ id: "a-1", status: "ACCEPTED" })]);
    const hit = await loadSeoActionsPanel("project-1", {
      now: NOW,
      highlight: "a-1",
    });
    expect(hit?.needsYou[0]?.highlighted).toBe(true);
    const miss = await loadSeoActionsPanel("project-1", {
      now: NOW,
      highlight: "../a-1",
    });
    expect(miss?.needsYou[0]?.highlighted).toBe(false);
  });
});

describe("itemOf", () => {
  it("derives the can flags from the status", () => {
    const flags = (overrides: Partial<SeoActionView>) =>
      itemOf(action(overrides), null).can;
    expect(flags({ status: "ACCEPTED" })).toEqual({
      apply: true,
      undo: false,
      dismiss: true,
      confirmLive: false,
      checkNow: false,
    });
    expect(flags({ status: "PROPOSED" }).apply).toBe(true);
    expect(
      flags({ status: "PROPOSED", commandId: "c", workId: "w" }).apply,
    ).toBe(false);
    expect(flags({ status: "APPLIED" })).toEqual({
      apply: false,
      undo: true,
      dismiss: false,
      confirmLive: false,
      checkNow: true,
    });
    expect(
      flags({ status: "APPLIED", askedAt: new Date(NOW) }).confirmLive,
    ).toBe(true);
    expect(flags({ status: "VERIFIED" }).checkNow).toBe(true);
    expect(flags({ status: "EVALUATING" })).toEqual({
      apply: false,
      undo: false,
      dismiss: false,
      confirmLive: false,
      checkNow: false,
    });
  });

  it("offers It's live when our crawler cannot check the page", () => {
    for (const reason of ["NO_SITE", "ROBOTS", "OUT_OF_SCOPE"] as const) {
      const item = itemOf(
        action({
          status: "APPLIED",
          verification: {
            ...action().verification,
            reason,
          },
        }),
        null,
      );
      expect(item.can.confirmLive).toBe(true);
      expect(item.ask).toBeNull();
    }
    const fetchFailed = itemOf(
      action({
        status: "APPLIED",
        verification: { ...action().verification, reason: "FETCH_FAILED" },
      }),
      null,
    );
    expect(fetchFailed.can.confirmLive).toBe(false);
  });

  it("maps the status to a tone", () => {
    const tone = (status: SeoActionStatus) =>
      itemOf(action({ status }), null).tone;
    expect(tone("WORKED")).toBe("positive");
    expect(tone("DIDNT")).toBe("negative");
    expect(tone("INCONCLUSIVE")).toBe("neutral");
    expect(tone("APPLIED")).toBe("waiting");
    expect(tone("EVALUATING")).toBe("waiting");
  });

  it("writes the headline and detail from the evaluation", () => {
    const item = itemOf(
      action({
        status: "WORKED",
        evaluation: evaluation(),
        evaluatedAt: NOW,
      }),
      null,
    );
    expect(item.headline).toBe("Worked: +18% CTR");
    expect(item.detail).toBe(
      "Compared with 6 similar pages · likely between +9% and +27%",
    );
    expect(itemOf(action({ status: "APPLIED" }), null).headline).toBeNull();
  });

  it("links the card and only shows the checklist while it is not applied", () => {
    const withCard = itemOf(
      action({
        status: "ACCEPTED",
        projectId: "project-1",
        commandId: "cmd-1",
        workId: "seofix_a b",
      }),
      null,
    );
    expect(withCard.cardHref).toBe("/projects/project-1?work=seofix_a%20b");
    expect(withCard.instructions).toBeNull();
    const checklist = itemOf(action({ status: "ACCEPTED" }), null);
    expect(checklist.cardHref).toBeNull();
    expect(checklist.instructions?.length).toBeGreaterThan(1);
    expect(itemOf(action({ status: "APPLIED" }), null).instructions).toBeNull();
  });

  it("notes measuring and waiting states", () => {
    expect(
      itemOf(
        action({
          status: "EVALUATING",
          evaluateAfter: new Date("2026-11-03T00:00:00.000Z"),
        }),
        null,
      ).note,
    ).toBe("Measuring. Results expected around Nov 3.");
    expect(itemOf(action({ status: "VERIFIED" }), null).note).toContain(
      "Waiting for Google",
    );
  });

  it("never puts the keyword or a query string in the visible text", () => {
    const item = itemOf(
      action({
        kind: "CONTENT_REFRESH",
        status: "ACCEPTED",
        targetUrl: "https://example.com/guide?utm_source=x&q=secret#top",
        proposal: {
          kind: "CONTENT_REFRESH",
          primaryKeyword: "blue widgets cheap",
          missing: ["pricing"],
          after: null,
          v: 1,
          note: null,
          alert: null,
        },
      }),
      null,
    );
    const text = JSON.stringify(item);
    expect(text).not.toContain("blue widgets");
    expect(text).not.toContain("utm_source");
    expect(text).not.toContain("secret");
    expect(item.targetPath).toBe("/guide");
    expect(item.title).toBe("Content refresh · /guide");
    expect(item.proposalLines).toEqual(["Cover: pricing"]);
  });
});

describe("cleanPath", () => {
  it("drops the query, masks personal data and clamps the length", () => {
    expect(cleanPath("https://example.com/a?x=1")).toBe("/a");
    expect(cleanPath("https://example.com/john@example.com/page")).toBe(
      "/[email]/page",
    );
    expect(cleanPath(`https://example.com/${"a".repeat(100)}`)?.length).toBe(
      60,
    );
    expect(cleanPath(null)).toBeNull();
    expect(cleanPath("not a url")).toBeNull();
  });
});
