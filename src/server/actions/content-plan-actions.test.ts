import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const tx = {
  command: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
  creative: { create: vi.fn() },
};
const commandFindUnique = vi.fn();
const workFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findUnique: commandFindUnique },
    work: { findFirst: workFindFirst },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

const worksEnabled = vi.fn().mockReturnValue(false);
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: worksEnabled }));
const loadBrandRules = vi.fn();
vi.mock("@/server/works/brand-rule-loader", () => ({ loadBrandRules }));
const ruleLanguageOf = vi.fn();
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: ruleLanguageOf,
}));

const coreSpy = vi.fn();
vi.mock("@/server/chat/save-plan-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/chat/save-plan-core")>();
  return {
    ...actual,
    savePlanSlotsInTx: (...args: Parameters<typeof actual.savePlanSlotsInTx>) => {
      coreSpy(...args);
      return actual.savePlanSlotsInTx(...args);
    },
  };
});

const { saveContentPlanAction } = await import("./content-plan-actions");

const draft = (state: string) => ({
  card: {
    kind: "content-plan-draft",
    title: "Plan",
    timezone: "Europe/Istanbul",
    state,
    items: [
      {
        date: "2026-10-01",
        time: "10:00",
        platform: "INSTAGRAM",
        format: "Reel",
        topic: "Launch teaser",
        captionIdea: "Behind the scenes",
      },
      {
        date: "2026-10-03",
        time: "18:30",
        platform: "LINKEDIN",
        topic: "Founder story",
        captionIdea: "Why we started",
      },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  worksEnabled.mockReturnValue(false);
  loadBrandRules.mockResolvedValue(null);
  ruleLanguageOf.mockResolvedValue("de");
  workFindFirst.mockResolvedValue({ status: "ACTIVE" });
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  commandFindUnique.mockResolvedValue({ projectId: "proj-1" });
  tx.command.findUnique.mockResolvedValue({
    projectId: "proj-1",
    parsedIntent: draft("draft"),
  });
  let n = 0;
  tx.creative.create.mockImplementation(async () => ({ id: `cr-${++n}` }));
});

describe("saveContentPlanAction", () => {
  it("stores each slot as a dated DRAFT creative in the project's timezone", async () => {
    const result = await saveContentPlanAction("cmd-1");

    expect(result).toEqual({ ok: true, saved: 2 });
    const first = tx.creative.create.mock.calls[0]![0].data;
    expect(first).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "SOCIAL_POST",
      platform: "INSTAGRAM",
      status: "DRAFT",
      title: "Launch teaser",
      // A legacy "Reel" resolves to the catalog: the format is structured now
      // instead of a "[Reel]" prefix on the brief.
      brief: "Behind the scenes",
      channel: "instagram",
      formatKey: "instagram.reel",
      planId: "cmd-1",
    });
    // 10:00 in Istanbul (UTC+3) is 07:00 UTC.
    expect((first.scheduledFor as Date).toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
    expect(tx.creative.create.mock.calls[1]![0].data.brief).toBe("Why we started");

    const saved = tx.command.update.mock.calls[0]![0].data.parsedIntent.card;
    expect(saved).toMatchObject({
      state: "saved",
      savedCreativeIds: ["cr-1", "cr-2"],
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "content_plan.saved" }),
    );
  });

  it("saves channel, format and goal for a catalog plan (blog and ads are not social posts)", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: {
        card: {
          kind: "content-plan-draft",
          title: "Plan",
          timezone: "Europe/Istanbul",
          state: "draft",
          goal: "leads",
          items: [
            {
              date: "2026-10-01",
              time: "10:00",
              platform: "INSTAGRAM",
              channel: "instagram",
              formatKey: "instagram.carousel",
              topic: "Carousel topic",
              captionIdea: "Slides",
            },
            {
              date: "2026-10-02",
              time: "10:00",
              channel: "seo",
              formatKey: "seo.article",
              topic: "Article topic",
              captionIdea: "Target keyword",
            },
            {
              date: "2026-10-03",
              time: "10:00",
              channel: "ads",
              formatKey: "ads.campaign",
              topic: "Offer",
              captionIdea: "Audience",
            },
          ],
        },
      },
    });

    expect(await saveContentPlanAction("cmd-1")).toEqual({ ok: true, saved: 3 });
    const [carousel, article, ads] = tx.creative.create.mock.calls.map(
      (call) => call[0].data,
    );
    expect(carousel).toMatchObject({
      type: "SOCIAL_POST",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.carousel",
      goal: "leads",
      planId: "cmd-1",
      brief: "Slides",
    });
    expect(article).toMatchObject({
      type: "COPY",
      platform: undefined,
      channel: "seo",
      formatKey: "seo.article",
    });
    expect(ads).toMatchObject({
      type: "CAMPAIGN_BRIEF",
      platform: undefined,
      channel: "ads",
      formatKey: "ads.campaign",
    });
  });

  it("keeps the old shape for a platform the catalog does not cover", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: {
        card: {
          kind: "content-plan-draft",
          title: "Plan",
          timezone: "Europe/Istanbul",
          state: "draft",
          items: [
            {
              date: "2026-10-01",
              time: "10:00",
              platform: "FACEBOOK",
              format: "Live",
              topic: "Q&A",
              captionIdea: "Ask us",
            },
          ],
        },
      },
    });

    await saveContentPlanAction("cmd-1");
    expect(tx.creative.create.mock.calls[0]![0].data).toMatchObject({
      type: "SOCIAL_POST",
      platform: "FACEBOOK",
      brief: "[Live] Ask us",
      channel: undefined,
      formatKey: undefined,
    });
  });

  it("refuses to save twice or to save a replaced plan", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: draft("saved"),
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("already saved"),
    });

    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: draft("superseded"),
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("newer version"),
    });
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it("checks project access before touching anything", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({ ok: false });
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it("does not treat a non-plan command as a plan", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: { card: { kind: "question", questions: [] } },
    });
    expect(await saveContentPlanAction("cmd-1")).toMatchObject({
      ok: false,
      message: "Plan not found.",
    });
  });

  it("delegates to the save core with the same tx and the access scope", async () => {
    await saveContentPlanAction("cmd-1");
    expect(coreSpy).toHaveBeenCalledTimes(1);
    expect(coreSpy.mock.calls[0]![0]).toBe(tx);
    expect(coreSpy.mock.calls[0]![1]).toEqual({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
    });
    expect(coreSpy.mock.calls[0]![2]).toBe("cmd-1");
  });
});

describe("saveContentPlanAction in a Work", () => {
  const rules = {
    language: "en",
    never: [{ text: "guaranteed", origin: "client-rule" }],
    approvedClaims: [],
    competitors: [],
  };
  const blockedCard = () => {
    const d = draft("draft");
    d.card.items[0]!.topic = "Guaranteed results";
    return d;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T06:00:00Z"));
    worksEnabled.mockReturnValue(true);
    loadBrandRules.mockResolvedValue(rules);
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      workId: "w1",
      parsedIntent: draft("draft"),
    });
  });
  afterEach(() => vi.useRealTimers());

  it("flag off: one command read, no brand load, same tx body", async () => {
    worksEnabled.mockReturnValue(false);
    expect(await saveContentPlanAction("cmd-1")).toEqual({ ok: true, saved: 2 });
    expect(commandFindUnique).toHaveBeenCalledTimes(1);
    expect(loadBrandRules).not.toHaveBeenCalled();
  });

  it("flag on but no workId: no brand load", async () => {
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      workId: null,
      parsedIntent: blockedCard(),
    });
    expect((await saveContentPlanAction("cmd-1")).ok).toBe(true);
    expect(loadBrandRules).not.toHaveBeenCalled();
  });

  it("refuses a Completed Work before the tx and before any rules load", async () => {
    workFindFirst.mockResolvedValue({ status: "DONE" });
    const result = await saveContentPlanAction("cmd-1", { allowIssues: true });
    expect(result).toEqual({
      ok: false,
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(workFindFirst).toHaveBeenCalledWith({
      where: { id: "w1", projectId: "proj-1" },
      select: { status: true },
    });
    expect(loadBrandRules).not.toHaveBeenCalled();
    expect(tx.command.findUnique).not.toHaveBeenCalled();
  });

  it("returns STALE before the tx, even with allowIssues", async () => {
    const d = blockedCard();
    d.card.items[0]!.date = "2026-09-20";
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      workId: "w1",
      parsedIntent: d,
    });
    const result = await saveContentPlanAction("cmd-1", { allowIssues: true });
    expect(result).toEqual({
      ok: false,
      code: "STALE",
      message: "Some days in this plan have passed. Ask me to plan again.",
    });
    expect(tx.command.findUnique).not.toHaveBeenCalled();
  });

  it("loads the brand rules in the project language, not a hard-coded one", async () => {
    await saveContentPlanAction("cmd-1");
    expect(ruleLanguageOf).toHaveBeenCalledWith("proj-1");
    expect(loadBrandRules).toHaveBeenCalledWith(
      expect.objectContaining({ language: "de" }),
    );
  });

  it("blocks on a brand rule before the tx", async () => {
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      workId: "w1",
      parsedIntent: blockedCard(),
    });
    const result = await saveContentPlanAction("cmd-1");
    expect(result).toMatchObject({ ok: false, code: "BRAND_RULES" });
    expect(tx.command.findUnique).not.toHaveBeenCalled();
  });

  it("allowIssues saves and the audit carries the matched terms and user", async () => {
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      workId: "w1",
      parsedIntent: blockedCard(),
    });
    const result = await saveContentPlanAction("cmd-1", { allowIssues: true });
    expect(result).toEqual({ ok: true, saved: 2 });
    const meta = auditRecord.mock.calls[0]![0].metadata;
    expect(meta).toMatchObject({ allowIssues: true, userId: "u1" });
    expect(meta.matched.length).toBeGreaterThan(0);
  });

  it("maps P2034 to 'Already being saved.' and other errors to the generic text", async () => {
    const race = Object.assign(new Error("raw prisma text"), { code: "P2034" });
    tx.command.findUnique.mockRejectedValueOnce(race);
    expect(await saveContentPlanAction("cmd-1")).toEqual({
      ok: false,
      message: "Already being saved.",
    });
    tx.command.findUnique.mockRejectedValueOnce(new Error("boom"));
    expect(await saveContentPlanAction("cmd-1")).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
  });

  it("flag off keeps the raw error message", async () => {
    worksEnabled.mockReturnValue(false);
    const race = Object.assign(new Error("raw prisma text"), { code: "P2034" });
    tx.command.findUnique.mockRejectedValueOnce(race);
    expect(await saveContentPlanAction("cmd-1")).toEqual({
      ok: false,
      message: "raw prisma text",
    });
  });
});
