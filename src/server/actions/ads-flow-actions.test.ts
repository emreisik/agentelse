import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// The Ads Manager flow's actions over an in-memory card: every IO module is
// mocked, the card store is a row that applies the action's own update, so
// what the card ends up holding is what production would write.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
  commandFindFirst: vi.fn(),
  creativeFindMany: vi.fn(),
  creativeFindFirst: vi.fn(),
  credentialFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  assetFindFirst: vi.fn(),
  taskFindFirst: vi.fn(),
  approvalFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  workFindFirst: vi.fn(),
  updateModuleFlowCard: vi.fn(),
  planForCapability: vi.fn(),
  reasoningRun: vi.fn(),
  isMockMode: vi.fn(),
  getBrandTwin: vi.fn(),
  loadBrandRules: vi.fn(),
  ruleLanguageOf: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findFirst: mocks.commandFindFirst },
    creative: {
      findMany: mocks.creativeFindMany,
      findFirst: mocks.creativeFindFirst,
    },
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    project: { findUnique: mocks.projectFindUnique },
    asset: { findFirst: mocks.assetFindFirst },
    task: { findFirst: mocks.taskFindFirst },
    approval: { findMany: mocks.approvalFindMany },
    executionJob: { findMany: mocks.jobFindMany },
    work: { findFirst: mocks.workFindFirst },
  },
}));
vi.mock("@/server/modules/flow-card", () => ({
  updateModuleFlowCard: mocks.updateModuleFlowCard,
}));
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability: mocks.planForCapability },
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.reasoningRun, isMockMode: mocks.isMockMode },
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: mocks.getBrandTwin,
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: mocks.loadBrandRules,
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: mocks.ruleLanguageOf,
}));
vi.mock("@/server/integrations/meta-client", () => ({
  META_PROVIDER: {
    instagram: "instagram",
    facebook: "facebook",
    ads: "meta_ads",
  },
}));

import {
  draftAdsPlanAction,
  launchAdsAction,
  loadAdsBriefOptionsAction,
  loadAdsLaunchAction,
  relaunchAdsAction,
  saveAdsBriefAction,
  saveAdsPlanAction,
  setAdsStepAction,
} from "@/server/actions/ads-flow-actions";
import {
  adsLaunchPayload,
  type AdsBrief,
  type AdsPlan,
} from "@/lib/module-flows/ads/state";
import { AgentelseError } from "@/server/security/errors";

const PROJECT = "p1";
const CMD = "cmd1";

let row: { card: ModuleFlowCardData; active: boolean };

function card(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown> = {},
): ModuleFlowCardData {
  return {
    kind: "module-flow",
    module: "ads",
    title: "Ads Manager",
    step,
    data,
  };
}

const SOURCE = {
  creativeId: "cr1",
  assetId: "as1",
  title: "Spring menu",
  caption: "Our spring menu is here: fresh herbs and a new lemonade.",
};

const BRIEF: AdsBrief = {
  objective: "OUTCOME_TRAFFIC",
  dailyBudget: 20,
  days: 7,
  countries: ["TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link: "https://cafelale.com",
  callToAction: "LEARN_MORE",
  source: SOURCE,
  currency: "TRY",
  pageName: "Cafe Lale",
};

const PLAN: AdsPlan = {
  campaignName: "Spring menu · Traffic",
  adSetName: "TR · 18–65+",
  adName: "Spring menu",
  primaryText: "Fresh herbs and a new lemonade: our spring menu is here.",
};

const INPUT = {
  creativeId: "cr1",
  objective: "OUTCOME_TRAFFIC",
  dailyBudget: 20,
  days: 7,
  countries: ["TR", "TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link: "https://cafelale.com",
  callToAction: "LEARN_MORE",
};

function credential(over: Record<string, unknown> = {}) {
  return {
    status: "ACTIVE",
    metadata: {
      selectedAdAccountId: "act_1",
      adAccounts: [
        { adAccountId: "act_1", adAccountName: "Main", currency: "TRY" },
      ],
      selectedPageId: "pg1",
      pages: [{ pageId: "pg1", pageName: "Cafe Lale" }],
      ...over,
    },
  };
}

function creativeRow(
  id: string,
  over: {
    status?: string;
    postId?: string | null;
    formatKey?: string | null;
    contentFormat?: string | null;
    mimeType?: string;
    storageKey?: string;
    title?: string | null;
  } = {},
) {
  return {
    id,
    title: over.title === undefined ? `Post ${id}` : over.title,
    status: over.status ?? "APPROVED",
    channel: "instagram",
    formatKey: over.formatKey ?? "instagram.post",
    postId: over.postId === undefined ? null : over.postId,
    versions: [
      {
        caption: `Caption of ${id}`,
        copy: null,
        contentFormat: over.contentFormat ?? "FEED_PORTRAIT",
        asset: {
          id: `asset-${id}`,
          mimeType: over.mimeType ?? "image/png",
          storageKey: over.storageKey ?? `k/${id}`,
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  row = { card: card("brief"), active: true };
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws1",
    defaultBrandId: "b1",
  });
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.commandFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === CMD && where.projectId === PROJECT
        ? { parsedIntent: { card: row.card }, workId: "w1" }
        : null,
  );
  mocks.updateModuleFlowCard.mockImplementation(
    async ({
      update,
    }: {
      update: (
        c: ModuleFlowCardData,
      ) => ModuleFlowCardData | { reject: string };
    }) => {
      if (!row.active) {
        return {
          ok: false,
          message: "This Work is completed. Reopen it to continue.",
        };
      }
      const next = update(row.card);
      if ("reject" in next) return { ok: false, message: next.reject };
      row.card = next;
      return { ok: true, card: next };
    },
  );
  mocks.credentialFindUnique.mockResolvedValue(credential());
  mocks.creativeFindFirst.mockResolvedValue(creativeRow("cr1"));
  mocks.creativeFindMany.mockResolvedValue([]);
  mocks.projectFindUnique.mockResolvedValue({
    domain: "cafelale.com",
    country: "TR",
    countries: ["TR", "DE"],
  });
  mocks.assetFindFirst.mockResolvedValue({ id: "as1" });
  mocks.workFindFirst.mockResolvedValue({ status: "ACTIVE" });
  mocks.isMockMode.mockReturnValue(false);
  mocks.getBrandTwin.mockResolvedValue(null);
  mocks.loadBrandRules.mockResolvedValue(null);
  mocks.ruleLanguageOf.mockResolvedValue("tr");
  mocks.approvalFindMany.mockResolvedValue([]);
  mocks.jobFindMany.mockResolvedValue([]);
  mocks.taskFindFirst.mockResolvedValue(null);
});

const data = () => row.card.data as Record<string, unknown>;

describe("loadAdsBriefOptionsAction", () => {
  it("offers one picture per post, newest first, with the project's defaults", async () => {
    row.card = card("brief", { hint: { sourceCreativeId: "old" } });
    mocks.creativeFindMany.mockResolvedValue([
      creativeRow("story", {
        postId: "post1",
        formatKey: "instagram.story",
        contentFormat: "STORY",
      }),
      creativeRow("feed", { postId: "post1" }),
      creativeRow("video", { mimeType: "video/mp4" }),
      creativeRow("mock", { storageKey: "mock://x" }),
      creativeRow("draft", { status: "IN_REVIEW" }),
      creativeRow("posted", { status: "PUBLISHED", title: null }),
    ]);
    mocks.creativeFindFirst.mockResolvedValue(creativeRow("old"));

    const result = await loadAdsBriefOptionsAction(PROJECT, CMD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { account, posts, defaults } = result.options;
    expect(account).toEqual({
      status: "ready",
      currency: "TRY",
      adAccountName: "Main",
      pageName: "Cafe Lale",
    });
    // The hinted post comes first even though it is older than the rest.
    expect(posts.map((post) => post.creativeId)).toEqual([
      "old",
      "feed",
      "posted",
    ]);
    expect(posts[2]?.title).toBe("Caption of posted");
    expect(defaults).toEqual({
      link: "https://cafelale.com",
      countries: ["TR", "DE"],
    });
  });

  it("says what is missing on the Meta Ads side", async () => {
    mocks.credentialFindUnique.mockResolvedValueOnce(null);
    let result = await loadAdsBriefOptionsAction(PROJECT, CMD);
    expect(result.ok && result.options.account.status).toBe("needs-connect");

    mocks.credentialFindUnique.mockResolvedValueOnce(
      credential({ selectedAdAccountId: undefined }),
    );
    result = await loadAdsBriefOptionsAction(PROJECT, CMD);
    expect(result.ok && result.options.account.status).toBe("needs-account");

    mocks.credentialFindUnique.mockResolvedValueOnce(
      credential({ selectedPageId: undefined }),
    );
    result = await loadAdsBriefOptionsAction(PROJECT, CMD);
    expect(result.ok && result.options.account.status).toBe("needs-page");
  });

  it("never reads another project's card", async () => {
    const result = await loadAdsBriefOptionsAction("other", CMD);
    expect(result).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
    expect(mocks.creativeFindMany).not.toHaveBeenCalled();
  });
});

describe("saveAdsBriefAction", () => {
  it("saves the brief with the post frozen and moves to the Plan", async () => {
    const result = await saveAdsBriefAction(PROJECT, CMD, {
      ...INPUT,
      dailyBudget: 20.004,
    });
    expect(result).toEqual({ ok: true, hasPlan: false });
    expect(row.card.step).toBe("plan");
    expect(data().brief).toEqual({
      ...BRIEF,
      source: {
        ...SOURCE,
        title: "Post cr1",
        caption: "Caption of cr1",
        assetId: "asset-cr1",
      },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
  });

  it("refuses an incomplete brief with the reason", async () => {
    const result = await saveAdsBriefAction(PROJECT, CMD, {
      ...INPUT,
      countries: [],
    });
    expect(result).toEqual({
      ok: false,
      message: "Pick at least one country.",
    });
    expect(mocks.updateModuleFlowCard).not.toHaveBeenCalled();
  });

  it("is blocked until Meta Ads is connected", async () => {
    mocks.credentialFindUnique.mockResolvedValue(null);
    const result = await saveAdsBriefAction(PROJECT, CMD, INPUT);
    expect(result).toEqual({ ok: false, message: "Connect Meta Ads first." });
    expect(row.card.step).toBe("brief");
  });

  it("refuses a post that is not approved or has no picture", async () => {
    mocks.creativeFindFirst.mockResolvedValue(null);
    const result = await saveAdsBriefAction(PROJECT, CMD, INPUT);
    expect(result.ok).toBe(false);
    expect(row.card.data).toEqual({});
  });

  it("keeps the written ad for a budget change, drops it for another goal", async () => {
    row.card = card("review", {
      brief: { ...BRIEF, source: { ...SOURCE, creativeId: "cr1" } },
      plan: PLAN,
    });
    const kept = await saveAdsBriefAction(PROJECT, CMD, {
      ...INPUT,
      dailyBudget: 50,
    });
    expect(kept).toEqual({ ok: true, hasPlan: true });
    expect(data().plan).toEqual(PLAN);

    const dropped = await saveAdsBriefAction(PROJECT, CMD, {
      ...INPUT,
      objective: "OUTCOME_AWARENESS",
    });
    expect(dropped).toEqual({ ok: true, hasPlan: false });
    expect(data().plan).toBeUndefined();
  });

  it("never changes a launched card", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      launch: { claimId: "c1", startedAt: "2026-10-05T10:00:00.000Z" },
    });
    const result = await saveAdsBriefAction(PROJECT, CMD, INPUT);
    expect(result).toEqual({
      ok: false,
      message: "This ad was launched already.",
    });
  });
});

describe("draftAdsPlanAction", () => {
  beforeEach(() => {
    row.card = card("plan", { brief: BRIEF });
  });

  it("writes the AI's names and text, cleaned and clipped", async () => {
    mocks.reasoningRun.mockResolvedValue({
      output: {
        campaignName: "Bahar menüsü · Trafik",
        adSetName: "TR · 18-65",
        adName: "Bahar menüsü",
        primaryText: `Taze otlar ve yeni limonata! https://cafelale.com #bahar ${"çok ".repeat(40)}`,
      },
    });
    const result = await draftAdsPlanAction(PROJECT, CMD);
    expect(result.ok).toBe(true);
    const plan = data().plan as AdsPlan;
    expect(plan.campaignName).toBe("Bahar menüsü · Trafik");
    expect(plan.primaryText.length).toBeLessThanOrEqual(125);
    expect(plan.primaryText).not.toMatch(/https?:|#bahar/);
    expect(row.card.step).toBe("plan");
    // The brand's language and context went to the model.
    const facts = mocks.reasoningRun.mock.calls[0]![1].context.facts;
    expect(facts.language).toBe("tr");
    expect(facts.post.caption).toBe(SOURCE.caption);
  });

  it("does not pay twice for a plan that is already written", async () => {
    row.card = card("plan", { brief: BRIEF, plan: PLAN });
    const result = await draftAdsPlanAction(PROJECT, CMD);
    expect(result).toEqual({ ok: true, plan: PLAN });
    expect(mocks.reasoningRun).not.toHaveBeenCalled();
  });

  it("tells the daily limit and leaves the card as it was", async () => {
    mocks.reasoningRun.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    const result = await draftAdsPlanAction(PROJECT, CMD, { regenerate: true });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/AI budget/);
    expect(data().plan).toBeUndefined();
  });

  it("never writes a mock answer into a real card", async () => {
    mocks.isMockMode.mockReturnValue(true);
    const result = await draftAdsPlanAction(PROJECT, CMD);
    expect(result.ok).toBe(false);
    expect(mocks.reasoningRun).not.toHaveBeenCalled();
  });

  it("refuses in a completed Work before calling the model", async () => {
    mocks.workFindFirst.mockResolvedValue({ status: "COMPLETED" });
    const result = await draftAdsPlanAction(PROJECT, CMD);
    expect(result.ok).toBe(false);
    expect(mocks.reasoningRun).not.toHaveBeenCalled();
  });
});

describe("saveAdsPlanAction and setAdsStepAction", () => {
  it("keeps the edited texts and moves to Create", async () => {
    row.card = card("plan", {
      brief: BRIEF,
      plan: { ...PLAN, flags: ["en iyi"] },
    });
    const result = await saveAdsPlanAction(PROJECT, CMD, {
      ...PLAN,
      primaryText: "Edited text",
    });
    expect(result).toEqual({ ok: true });
    expect(row.card.step).toBe("create");
    // The AI's brand-rule note no longer fits the edited words.
    expect(data().plan).toEqual({ ...PLAN, primaryText: "Edited text" });
  });

  it("refuses an empty name", async () => {
    row.card = card("plan", { brief: BRIEF });
    const result = await saveAdsPlanAction(PROJECT, CMD, {
      ...PLAN,
      adName: "",
    });
    expect(result.ok).toBe(false);
    expect(row.card.step).toBe("plan");
  });

  it("goes back before the launch, and from Create on to Review", async () => {
    row.card = card("review", { brief: BRIEF, plan: PLAN });
    expect(await setAdsStepAction(PROJECT, CMD, "brief")).toEqual({ ok: true });
    expect(row.card.step).toBe("brief");

    row.card = card("create", { brief: BRIEF, plan: PLAN });
    expect(await setAdsStepAction(PROJECT, CMD, "review")).toEqual({
      ok: true,
    });
    expect(row.card.step).toBe("review");

    row.card = card("plan", { brief: BRIEF, plan: PLAN });
    expect((await setAdsStepAction(PROJECT, CMD, "review")).ok).toBe(false);
    expect((await setAdsStepAction(PROJECT, CMD, "deliver")).ok).toBe(false);
  });
});

describe("launchAdsAction", () => {
  beforeEach(() => {
    row.card = card("review", { brief: BRIEF, plan: PLAN });
    mocks.planForCapability.mockResolvedValue({ task: { id: "t-campaign" } });
  });

  it("plans the campaign with the card as its lineage, everything paused", async () => {
    const result = await launchAdsAction(PROJECT, CMD);
    expect(result).toEqual({ ok: true });
    expect(mocks.planForCapability).toHaveBeenCalledTimes(1);
    expect(mocks.planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        projectId: PROJECT,
        brandId: "b1",
        commandId: CMD,
        capability: "META_CAMPAIGN_CREATE",
        createdByType: "USER",
        createdByUserId: "u1",
        departmentKey: "PERFORMANCE_MARKETING",
        payloadExtra: adsLaunchPayload(BRIEF, PLAN),
      }),
    );
    expect(row.card.step).toBe("deliver");
    expect(data().launch).toMatchObject({ campaignTaskId: "t-campaign" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT}/ads`,
    );
  });

  it("a second tap is the same launch", async () => {
    await launchAdsAction(PROJECT, CMD);
    const again = await launchAdsAction(PROJECT, CMD);
    expect(again).toEqual({ ok: true });
    expect(mocks.planForCapability).toHaveBeenCalledTimes(1);
  });

  it("a failed plan releases the card back to Review", async () => {
    mocks.planForCapability.mockRejectedValue(new Error("db down"));
    const result = await launchAdsAction(PROJECT, CMD);
    expect(result.ok).toBe(false);
    expect(row.card.step).toBe("review");
    expect(data().launch).toBeUndefined();
  });

  it("is refused without an ad account, and before the Review", async () => {
    mocks.credentialFindUnique.mockResolvedValue(
      credential({ selectedAdAccountId: undefined }),
    );
    expect((await launchAdsAction(PROJECT, CMD)).ok).toBe(false);
    mocks.credentialFindUnique.mockResolvedValue(credential());
    row.card = card("create", { brief: BRIEF, plan: PLAN });
    expect((await launchAdsAction(PROJECT, CMD)).ok).toBe(false);
    expect(mocks.planForCapability).not.toHaveBeenCalled();
  });

  it("asks to check the budget again when the ad account's currency changed", async () => {
    mocks.credentialFindUnique.mockResolvedValue(
      credential({
        adAccounts: [
          { adAccountId: "act_1", adAccountName: "Main", currency: "EUR" },
        ],
      }),
    );
    const result = await launchAdsAction(PROJECT, CMD);
    expect(result).toEqual({
      ok: false,
      message:
        "The Meta ad account changed since the brief. Go back to the Brief and check the budget.",
    });
    expect(mocks.planForCapability).not.toHaveBeenCalled();
    expect(row.card.step).toBe("review");
  });
});

describe("loadAdsLaunchAction and relaunchAdsAction", () => {
  const launched = (over: Record<string, unknown> = {}) =>
    card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      launch: {
        claimId: "c1",
        startedAt: "2026-10-05T10:00:00.000Z",
        campaignTaskId: "t-campaign",
        ...over,
      },
    });

  it("follows the lineage: campaign, then the relays' ad set and ad", async () => {
    row.card = launched();
    mocks.taskFindFirst.mockImplementation(
      async ({ where }: { where: { id?: string; fingerprint?: string } }) => {
        if (where.id === "t-campaign")
          return { id: "t-campaign", status: "COMPLETED" };
        if (where.fingerprint) {
          // The ad set exists; the ad not yet.
          return mocks.taskFindFirst.mock.calls.length === 2
            ? { id: "t-adset", status: "WAITING_APPROVAL" }
            : null;
        }
        return null;
      },
    );
    mocks.approvalFindMany.mockResolvedValue([
      { id: "ap-adset", taskId: "t-adset", status: "PENDING" },
    ]);
    mocks.jobFindMany.mockResolvedValue([
      {
        taskId: "t-campaign",
        errorMessage: null,
        rawResult: { campaignId: "c-1" },
      },
    ]);

    const result = await loadAdsLaunchAction(PROJECT, CMD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain.links.map((link) => link.state)).toEqual([
      "created",
      "approval",
      "waiting",
    ]);
    expect(result.chain.links[1]?.approvalId).toBe("ap-adset");
    expect(result.chain.campaignId).toBe("c-1");
    // Lookups are tenant-scoped.
    for (const call of mocks.taskFindFirst.mock.calls) {
      expect(call[0].where.projectId).toBe(PROJECT);
    }
  });

  it("remembers the finished launch on the card", async () => {
    row.card = launched();
    mocks.taskFindFirst
      .mockResolvedValueOnce({ id: "t-campaign", status: "COMPLETED" })
      .mockResolvedValueOnce({ id: "t-adset", status: "COMPLETED" })
      .mockResolvedValueOnce({ id: "t-ad", status: "COMPLETED" });
    const result = await loadAdsLaunchAction(PROJECT, CMD);
    expect(result.ok && result.chain.complete).toBe(true);
    expect(
      (data().launch as { completedAt?: string }).completedAt,
    ).toBeTruthy();
  });

  it("finds a campaign planned before its id was written back", async () => {
    row.card = launched({ campaignTaskId: undefined });
    mocks.taskFindFirst.mockResolvedValueOnce({
      id: "t-campaign",
      status: "WAITING_APPROVAL",
    });
    mocks.approvalFindMany.mockResolvedValue([
      { id: "ap-c", taskId: "t-campaign", status: "PENDING" },
    ]);
    const result = await loadAdsLaunchAction(PROJECT, CMD);
    expect(result.ok && result.chain.links[0]?.state).toBe("approval");
    expect(mocks.taskFindFirst.mock.calls[0]![0].where).toMatchObject({
      projectId: PROJECT,
      commandId: CMD,
      capability: "META_CAMPAIGN_CREATE",
    });
  });

  it("opens the Review again only once the launch stopped", async () => {
    row.card = launched();
    mocks.taskFindFirst.mockResolvedValue({
      id: "t-campaign",
      status: "WAITING_APPROVAL",
    });
    mocks.approvalFindMany.mockResolvedValue([
      { id: "ap-c", taskId: "t-campaign", status: "PENDING" },
    ]);
    expect((await relaunchAdsAction(PROJECT, CMD)).ok).toBe(false);
    expect(row.card.step).toBe("deliver");

    mocks.taskFindFirst.mockResolvedValue({
      id: "t-campaign",
      status: "CANCELLED",
    });
    mocks.approvalFindMany.mockResolvedValue([
      { id: "ap-c", taskId: "t-campaign", status: "REJECTED" },
    ]);
    expect(await relaunchAdsAction(PROJECT, CMD)).toEqual({ ok: true });
    expect(row.card.step).toBe("review");
    expect(data().launch).toBeUndefined();
    expect(data().plan).toEqual(PLAN);
  });

  it("a launch that never planned its campaign can be launched again", async () => {
    const recent = new Date().toISOString();
    row.card = launched({ campaignTaskId: undefined, startedAt: recent });
    let result = await loadAdsLaunchAction(PROJECT, CMD);
    expect(result.ok && result.chain.links[0]?.state).toBe("preparing");

    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    row.card = launched({ campaignTaskId: undefined, startedAt: longAgo });
    result = await loadAdsLaunchAction(PROJECT, CMD);
    expect(result.ok && result.chain.links[0]).toMatchObject({
      state: "failed",
      reason: "The launch didn't start. Launch it again.",
    });
    expect(await relaunchAdsAction(PROJECT, CMD)).toEqual({ ok: true });
    expect(row.card.step).toBe("review");
  });
});
