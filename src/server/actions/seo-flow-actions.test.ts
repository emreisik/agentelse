import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// The SEO Manager's card actions over the REAL card read/write (module card
// helpers), research and writing modules: the stored card is an in-memory
// row behind a stand-in of the module flow card's one writer, the model
// (ReasoningService) and Search Console are mocked, as are the calendar
// writer (calendar.test.ts covers it) and the manual-publish action.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  commandFindFirst: vi.fn(),
  workFindFirst: vi.fn(),
  projectFindUnique: vi.fn(),
  updateModuleFlowCard: vi.fn(),
  isMockMode: vi.fn(),
  run: vi.fn(),
  findActiveGoogleConnections: vi.fn(),
  getFreshGoogleAccessToken: vi.fn(),
  fetchSearchConsoleQueryRows: vi.fn(),
  getProjectTimezone: vi.fn(),
  placeSeoArticle: vi.fn(),
  seoPieceStatus: vi.fn(),
  markCreativePublishedAction: vi.fn(),
  workTouch: vi.fn(),
  audit: vi.fn(),
  after: vi.fn(),
  readSeoLearnings: vi.fn(),
  readTarget: vi.fn(),
  getAction: vi.fn(),
  actionForCard: vi.fn(),
  attachCreative: vi.fn(),
  createSeoAction: vi.fn(),
  transitionAction: vi.fn(),
  updateProposal: vi.fn(),
  pageCheckSite: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findFirst: mocks.commandFindFirst },
    work: { findFirst: mocks.workFindFirst },
    project: { findUnique: mocks.projectFindUnique },
  },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/modules/flow-card", () => ({
  updateModuleFlowCard: mocks.updateModuleFlowCard,
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode: mocks.isMockMode, run: mocks.run },
}));
vi.mock("@/server/integrations/google-connections", () => ({
  findActiveGoogleConnections: mocks.findActiveGoogleConnections,
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.getFreshGoogleAccessToken,
}));
vi.mock("@/server/integrations/google-client", () => ({
  fetchSearchConsoleQueryRows: mocks.fetchSearchConsoleQueryRows,
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: async () => null,
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: async () => "tr",
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: async () => ({
    language: "tr",
    never: [
      { text: "Never mention competitors by name", origin: "client-rule" },
    ],
    approvedClaims: ["Family owned since 1999"],
    competitors: [],
  }),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));
vi.mock("@/server/modules/seo/calendar", () => ({
  placeSeoArticle: mocks.placeSeoArticle,
  seoPieceStatus: mocks.seoPieceStatus,
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  markCreativePublishedAction: mocks.markCreativePublishedAction,
}));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { touch: mocks.workTouch },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

vi.mock("@/server/seo/actions/learnings", () => ({
  readSeoLearnings: mocks.readSeoLearnings,
}));
vi.mock("@/server/modules/seo/target", () => ({
  readTarget: mocks.readTarget,
}));
vi.mock("@/server/seo/actions/store", () => ({
  getAction: mocks.getAction,
  actionForCard: mocks.actionForCard,
  attachCreative: mocks.attachCreative,
  createSeoAction: mocks.createSeoAction,
  transitionAction: mocks.transitionAction,
  updateProposal: mocks.updateProposal,
}));
vi.mock("@/server/seo/actions/page-check", () => ({
  pageCheckSite: mocks.pageCheckSite,
}));
vi.mock("@/server/seo/actions/verify", () => ({
  SeoActionVerifier: { runAction: mocks.runAction },
}));

import { AgentelseError } from "@/server/security/errors";

import {
  goToSeoStepAction,
  markSeoPublishedAction,
  researchSeoAction,
  rewriteSeoArticleAction,
  scheduleSeoArticleAction,
  seoBriefDefaultsAction,
  writeSeoArticleAction,
} from "./seo-flow-actions";

const PROJECT = "p1";
const CMD = "cmd1";
const NOW = new Date("2026-10-05T10:00:00.000Z");
const COMPLETED = "This Work is completed. Reopen it to continue.";

const BRIEF = {
  topic: "Running shoes for beginners",
  siteUrl: "https://example.com",
  language: "tr",
  audience: "",
};

const PLAN = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare pairs.",
  titleOptions: [
    "How to choose running shoes for your first race",
    "Running shoes: a beginner's guide to the right pair",
  ],
  titleIndex: 0,
  metaDescription:
    "Pick running shoes that fit: what cushioning, drop and size mean, how to test a pair in the shop, and the mistakes beginners make most often.",
  outline: [
    { h2: "What running shoes do", points: ["cushioning"] },
    { h2: "How to choose", points: [] },
    { h2: "Where to buy", points: [] },
    { h2: "Next steps", points: [] },
  ],
  quickWins: { state: "not-connected" },
  researchedAt: "2026-10-05T09:00:00.000Z",
};

const words = (count: number) =>
  Array.from({ length: count }, () => "comfort").join(" ");
const MARKDOWN = `The right running shoes make every run easier.\n\n## How to choose running shoes\n\n${words(250)}`;

const ARTICLE = {
  title: "Running shoes",
  metaDescription: "Short meta.",
  markdown: MARKDOWN,
  writtenAt: "2026-10-05T09:30:00.000Z",
  rewrites: 0,
};

const DELIVERY = {
  postId: "post-1",
  creativeId: "cr-1",
  scheduledFor: "2026-10-09T07:00:00.000Z",
  timezone: "Europe/Istanbul",
};

// SC-F6 bayrakları: her testte kapalı başlar, test açarsa afterEach geri alır.
const FLAGS = ["SEO_ACTIONS", "SEO_HEALTH", "SEO_CRAWL"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  FLAGS.map((name) => [name, process.env[name]]),
);

function flagsOn(level: "manager" | "loop"): void {
  process.env.SEO_ACTIONS = "true";
  if (level === "loop") {
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
  }
}

const SITE = {
  siteId: "site1",
  projectId: "p1",
  scope: { kind: "VERIFIED_DOMAIN", root: "example.com", prefix: null, key: "k" },
  origin: "https://example.com",
  originHost: "example.com",
};

let row: { card: ModuleFlowCardData; workId: string | null };
let workStatus = "ACTIVE";

function card(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown> = {},
): ModuleFlowCardData {
  return {
    kind: "module-flow",
    module: "seo",
    title: "SEO Manager",
    step,
    data,
  };
}

const stored = () => row.card;
const storedData = () => row.card.data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of FLAGS) delete process.env[name];
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  workStatus = "ACTIVE";
  row = { card: card("brief"), workId: "w1" };
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws1",
    defaultBrandId: "b1",
  });
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.isMockMode.mockReturnValue(false);
  mocks.commandFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; projectId: string } }) =>
      where.id === CMD && where.projectId === PROJECT
        ? { parsedIntent: { card: row.card }, workId: row.workId }
        : null,
  );
  mocks.workFindFirst.mockImplementation(async () => ({ status: workStatus }));
  // The one writer: atomic over the in-memory row, refuses a completed Work.
  mocks.updateModuleFlowCard.mockImplementation(
    async (input: {
      update: (
        current: ModuleFlowCardData,
      ) => ModuleFlowCardData | { reject: string };
    }) => {
      if (workStatus !== "ACTIVE") return { ok: false, message: COMPLETED };
      const next = input.update(row.card);
      if ("reject" in next) return { ok: false, message: next.reject };
      row.card = next;
      return { ok: true, card: next };
    },
  );
  mocks.findActiveGoogleConnections.mockResolvedValue({
    analytics: null,
    searchConsole: {
      credential: { id: "cred", encryptedSecret: "s" },
      siteUrl: "sc-domain:example.com",
    },
  });
  mocks.getFreshGoogleAccessToken.mockResolvedValue("token");
  mocks.fetchSearchConsoleQueryRows.mockResolvedValue([
    {
      keys: ["trail running shoes"],
      clicks: 2,
      impressions: 800,
      ctr: 0,
      position: 12,
    },
    { keys: ["running"], clicks: 90, impressions: 5000, ctr: 0, position: 3 },
  ]);
  mocks.getProjectTimezone.mockResolvedValue("Europe/Istanbul");
  mocks.workTouch.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.readSeoLearnings.mockResolvedValue([]);
  mocks.getAction.mockResolvedValue(null);
  mocks.actionForCard.mockResolvedValue(null);
  mocks.attachCreative.mockResolvedValue(true);
  mocks.updateProposal.mockResolvedValue(true);
  mocks.transitionAction.mockResolvedValue({ ok: true, action: {} });
  mocks.createSeoAction.mockResolvedValue({
    action: { id: "new-action" },
    created: true,
  });
  mocks.pageCheckSite.mockResolvedValue(SITE);
  mocks.runAction.mockResolvedValue({ status: "pending", fetches: 1 });
  mocks.after.mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of FLAGS) {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("researchSeoAction", () => {
  const researchAnswer = {
    primaryKeyword: "running shoes",
    secondaryKeywords: ["best running shoes", "running shoes for flat feet"],
    searchIntent: "commercial",
    intentNote: "They compare pairs.",
    titleOptions: ["How to choose running shoes for your first race"],
    metaDescription: PLAN.metaDescription,
    outline: PLAN.outline,
  };

  it("claims the card, researches the brief and lands on Plan", async () => {
    let during: ModuleFlowCardData | null = null;
    mocks.run.mockImplementation(async () => {
      during = stored();
      return { output: researchAnswer, isMock: false, reasoningCallId: "r" };
    });

    const result = await researchSeoAction(PROJECT, CMD, {
      topic: "  Running shoes for beginners ",
      siteUrl: "example.com",
      language: "tr",
    });

    expect(result).toEqual({
      ok: true,
      message: "Keywords and outline are ready.",
    });
    // While the model worked, the card showed it (and refused a second tap).
    expect(during).toMatchObject({
      step: "plan",
      data: { run: { kind: "research" }, brief: BRIEF },
    });
    expect(stored().step).toBe("plan");
    expect(storedData().run).toBeUndefined();
    expect(storedData().brief).toEqual(BRIEF);
    expect(storedData().plan).toMatchObject({
      primaryKeyword: "running shoes",
      secondaryKeywords: ["best running shoes", "running shoes for flat feet"],
      quickWins: {
        state: "ok",
        items: [
          { query: "trail running shoes", impressions: 800, position: 12 },
        ],
      },
    });
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.research", webSearch: true });
    expect(call).toMatchObject({
      workspaceId: "ws1",
      projectId: PROJECT,
      brandId: "b1",
      context: { facts: { topic: BRIEF.topic, language: { code: "tr" } } },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, "w1", {
      summary: BRIEF.topic,
    });
  });

  it("refuses a brief it cannot use, and the mock model, before any claim", async () => {
    expect(
      await researchSeoAction(PROJECT, CMD, { topic: "ab", language: "tr" }),
    ).toEqual({ ok: false, message: "Add a topic of at least 3 characters." });
    mocks.isMockMode.mockReturnValue(true);
    const mock = await researchSeoAction(PROJECT, CMD, {
      topic: "Running shoes",
      language: "tr",
    });
    expect(mock).toMatchObject({ ok: false });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateModuleFlowCard).not.toHaveBeenCalled();
    expect(stored()).toEqual(card("brief"));
  });

  it("refuses a second research while one runs", async () => {
    row.card = card("plan", {
      brief: BRIEF,
      run: { id: "other", kind: "research", startedAt: NOW.toISOString() },
    });
    const result = await researchSeoAction(PROJECT, CMD);
    expect(result).toEqual({
      ok: false,
      message: "Already working on this card. It updates when it's done.",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("a failed call returns the card to its brief, the brief kept", async () => {
    mocks.run.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    const result = await researchSeoAction(PROJECT, CMD, {
      topic: "Running shoes for beginners",
      siteUrl: "example.com",
      language: "tr",
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toMatch(/budget/i);
    expect(stored().step).toBe("brief");
    expect(storedData()).toEqual({ brief: BRIEF });
  });

  it("researches the stored brief again after a crashed run", async () => {
    row.card = card("plan", {
      brief: BRIEF,
      run: {
        id: "crashed",
        kind: "research",
        startedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      },
    });
    mocks.run.mockResolvedValue({
      output: researchAnswer,
      isMock: false,
      reasoningCallId: "r",
    });
    expect(await researchSeoAction(PROJECT, CMD)).toMatchObject({ ok: true });
    expect(stored().step).toBe("plan");
    expect(storedData().run).toBeUndefined();
  });

  it("never acts on a card of another project", async () => {
    expect(await researchSeoAction("other", CMD, BRIEF)).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
  });
});

describe("writeSeoArticleAction", () => {
  const edits = {
    titleIndex: 1,
    metaDescription: PLAN.metaDescription,
    secondaryKeywords: ["best running shoes", "trail running shoes"],
    outline: [
      PLAN.outline[1],
      PLAN.outline[0],
      PLAN.outline[2],
      PLAN.outline[3],
    ],
  };

  beforeEach(() => {
    row.card = card("plan", { brief: BRIEF, plan: PLAN });
  });

  it("writes the plan as the person left it and lands on Review", async () => {
    let during: ModuleFlowCardData | null = null;
    mocks.run.mockImplementation(async () => {
      during = stored();
      return {
        output: { markdown: `# ${PLAN.titleOptions[1]}\n\n${MARKDOWN}` },
        isMock: false,
        reasoningCallId: "r",
      };
    });

    const result = await writeSeoArticleAction(PROJECT, CMD, edits);

    expect(result).toEqual({
      ok: true,
      message: "Your article is ready to review.",
    });
    expect(during).toMatchObject({
      step: "create",
      data: { run: { kind: "write" } },
    });
    expect(stored().step).toBe("review");
    expect(storedData().article).toEqual({
      title: PLAN.titleOptions[1],
      metaDescription: PLAN.metaDescription,
      // The repeated title (H1) is dropped: the title lives on its own.
      markdown: MARKDOWN,
      writtenAt: NOW.toISOString(),
      rewrites: 0,
    });
    expect(storedData().plan).toMatchObject({
      titleIndex: 1,
      secondaryKeywords: ["best running shoes", "trail running shoes"],
      outline: edits.outline,
    });
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.article" });
    expect(call.context).toMatchObject({
      mode: "write",
      facts: {
        title: PLAN.titleOptions[1],
        outline: edits.outline,
        keywords: { primary: "running shoes" },
        neverRules: ["Never mention competitors by name"],
        approvedClaims: ["Family owned since 1999"],
      },
    });
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, "w1", {
      summary: PLAN.titleOptions[1],
    });
  });

  it("refuses a plan it cannot write, before any claim", async () => {
    const result = await writeSeoArticleAction(PROJECT, CMD, {
      ...edits,
      outline: [...edits.outline, { h2: " ", points: [] }],
    });
    expect(result).toEqual({
      ok: false,
      message: "Give every section a heading, or remove it.",
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(stored().step).toBe("plan");
  });

  it("a failed writing returns to Plan with the person's edits kept", async () => {
    mocks.run.mockRejectedValue(new Error("boom"));
    const result = await writeSeoArticleAction(PROJECT, CMD, edits);
    expect(result).toEqual({
      ok: false,
      message: "Couldn't write the article. Try again.",
    });
    expect(stored().step).toBe("plan");
    expect(storedData().run).toBeUndefined();
    expect(storedData().plan).toMatchObject({
      titleIndex: 1,
      outline: edits.outline,
    });
  });

  it("a completed Work refuses the claim, so the model is never called", async () => {
    workStatus = "COMPLETED";
    expect(await writeSeoArticleAction(PROJECT, CMD, edits)).toEqual({
      ok: false,
      message: COMPLETED,
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("rewriteSeoArticleAction", () => {
  beforeEach(() => {
    row.card = card("review", { brief: BRIEF, plan: PLAN, article: ARTICLE });
  });

  it("rewrites with the notes and the on-page warnings, staying on Review", async () => {
    mocks.run.mockResolvedValue({
      output: {
        markdown: MARKDOWN,
        title: "How to choose running shoes for your first race",
        metaDescription: PLAN.metaDescription,
      },
      isMock: false,
      reasoningCallId: "r",
    });
    const result = await rewriteSeoArticleAction(
      PROJECT,
      CMD,
      " A shorter intro, please ",
    );
    expect(result).toEqual({ ok: true, message: "The article is rewritten." });
    expect(stored().step).toBe("review");
    expect(storedData().article).toMatchObject({
      title: "How to choose running shoes for your first race",
      metaDescription: PLAN.metaDescription,
      rewrites: 1,
    });
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call.context.mode).toBe("rewrite");
    expect(call.context.notes).toBe("A shorter intro, please");
    expect(call.context.facts.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Title length: 13 characters/),
        expect.stringMatching(/^Meta description: 11 characters/),
      ]),
    );
  });

  it("stops at the rewrite limit", async () => {
    row.card = card("review", {
      brief: BRIEF,
      plan: PLAN,
      article: { ...ARTICLE, rewrites: 5 },
    });
    expect(await rewriteSeoArticleAction(PROJECT, CMD)).toEqual({
      ok: false,
      message:
        "This article was rewritten 5 times. Edit it on your site instead.",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("goToSeoStepAction", () => {
  it("moves where the card allows it, Publish included", async () => {
    row.card = card("review", { brief: BRIEF, plan: PLAN, article: ARTICLE });
    expect(await goToSeoStepAction(PROJECT, CMD, "plan")).toEqual({ ok: true });
    expect(stored().step).toBe("plan");
    expect(await goToSeoStepAction(PROJECT, CMD, "review")).toEqual({
      ok: true,
    });
    expect(await goToSeoStepAction(PROJECT, CMD, "deliver")).toEqual({
      ok: true,
    });
    expect(stored().step).toBe("deliver");
  });

  it("answers STALE to a move the card no longer allows", async () => {
    row.card = card("brief", { brief: BRIEF });
    expect(await goToSeoStepAction(PROJECT, CMD, "review")).toEqual({
      ok: false,
      message: "This card changed. Refreshing.",
      code: "STALE",
    });
    expect(await goToSeoStepAction(PROJECT, CMD, "launch")).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
    expect(stored().step).toBe("brief");
  });
});

describe("scheduleSeoArticleAction", () => {
  beforeEach(() => {
    row.card = card("deliver", { brief: BRIEF, plan: PLAN, article: ARTICLE });
    mocks.placeSeoArticle.mockResolvedValue({
      postId: "post-1",
      creativeId: "cr-1",
      scheduledFor: new Date(DELIVERY.scheduledFor),
      reused: false,
    });
  });

  it("puts the article on the calendar at the picked time and says when", async () => {
    const result = await scheduleSeoArticleAction(
      PROJECT,
      CMD,
      "2026-10-09T10:00",
    );
    expect(result).toEqual({
      ok: true,
      message: "On your calendar for Fri 9 Oct, 10:00.",
    });
    expect(mocks.placeSeoArticle).toHaveBeenCalledWith({
      scope: { workspaceId: "ws1", projectId: PROJECT, brandId: "b1" },
      userId: "u1",
      commandId: CMD,
      workId: "w1",
      timezone: "Europe/Istanbul",
      when: "2026-10-09T10:00",
      article: ARTICLE,
      plan: expect.objectContaining({ primaryKeyword: "running shoes" }),
      brief: BRIEF,
    });
    expect(storedData().delivery).toEqual(DELIVERY);
    expect(stored().step).toBe("deliver");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT}/takvim`,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo.article_scheduled",
        entityId: "cr-1",
      }),
    );
  });

  it("refuses a time in the past, a value that is not a time, and a completed Work", async () => {
    expect(
      await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-01T10:00"),
    ).toEqual({
      ok: false,
      message: "Pick a time that's still ahead.",
    });
    expect(await scheduleSeoArticleAction(PROJECT, CMD, "tomorrow")).toEqual({
      ok: false,
      message: "Pick a day and a time.",
    });
    workStatus = "COMPLETED";
    expect(
      await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00"),
    ).toEqual({
      ok: false,
      message: COMPLETED,
    });
    expect(mocks.placeSeoArticle).not.toHaveBeenCalled();
  });
});

describe("markSeoPublishedAction", () => {
  it("marks the calendar piece published through the manual path", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    mocks.seoPieceStatus.mockResolvedValue("APPROVED");
    mocks.markCreativePublishedAction.mockResolvedValue({ ok: true });

    expect(await markSeoPublishedAction(PROJECT, CMD)).toEqual({
      ok: true,
      message: "Marked as published.",
    });
    expect(mocks.markCreativePublishedAction).toHaveBeenCalledWith("cr-1");
    expect(storedData().delivery).toEqual({
      ...DELIVERY,
      publishedAt: NOW.toISOString(),
    });
    expect(mocks.placeSeoArticle).not.toHaveBeenCalled();
  });

  it("without a calendar piece, places it now first", async () => {
    row.card = card("deliver", { brief: BRIEF, plan: PLAN, article: ARTICLE });
    mocks.placeSeoArticle.mockResolvedValue({
      postId: "post-2",
      creativeId: "cr-2",
      scheduledFor: NOW,
      reused: false,
    });
    mocks.seoPieceStatus.mockResolvedValue("APPROVED");
    mocks.markCreativePublishedAction.mockResolvedValue({ ok: true });

    expect(await markSeoPublishedAction(PROJECT, CMD)).toMatchObject({
      ok: true,
    });
    // 10:00 UTC is 13:00 in Istanbul.
    expect(mocks.placeSeoArticle).toHaveBeenCalledWith(
      expect.objectContaining({ when: "2026-10-05T13:00" }),
    );
    expect(mocks.markCreativePublishedAction).toHaveBeenCalledWith("cr-2");
    expect(storedData().delivery).toEqual({
      postId: "post-2",
      creativeId: "cr-2",
      scheduledFor: NOW.toISOString(),
      timezone: "Europe/Istanbul",
      publishedAt: NOW.toISOString(),
    });
  });

  it("does not mark twice a piece already marked on the calendar", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    mocks.seoPieceStatus.mockResolvedValue("PUBLISHED");
    expect(await markSeoPublishedAction(PROJECT, CMD)).toMatchObject({
      ok: true,
    });
    expect(mocks.markCreativePublishedAction).not.toHaveBeenCalled();
    expect(storedData().delivery).toMatchObject({
      publishedAt: NOW.toISOString(),
    });
  });

  it("a piece removed from the calendar is offered again", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    mocks.seoPieceStatus.mockResolvedValue(null);
    expect(await markSeoPublishedAction(PROJECT, CMD)).toEqual({
      ok: false,
      message: "This article is no longer on your calendar. Add it again.",
    });
    expect(storedData().delivery).toBeUndefined();
    expect(storedData().article).toEqual(ARTICLE);
    expect(mocks.markCreativePublishedAction).not.toHaveBeenCalled();
  });

  it("passes on what the manual path refuses", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    mocks.seoPieceStatus.mockResolvedValue("IN_REVIEW");
    mocks.markCreativePublishedAction.mockResolvedValue({
      ok: false,
      message: "Approve this piece before marking it as published.",
    });
    expect(await markSeoPublishedAction(PROJECT, CMD)).toEqual({
      ok: false,
      message: "Approve this piece before marking it as published.",
    });
    expect(storedData().delivery).toEqual(DELIVERY);
  });
});

describe("seoBriefDefaultsAction", () => {
  it("starts from the project's website and the brand's language", async () => {
    mocks.projectFindUnique.mockResolvedValue({ domain: "www.example.com" });
    expect(await seoBriefDefaultsAction(PROJECT)).toEqual({
      ok: true,
      siteUrl: "https://www.example.com",
      language: "tr",
    });
    mocks.projectFindUnique.mockResolvedValue({ domain: null });
    expect(await seoBriefDefaultsAction(PROJECT)).toEqual({
      ok: true,
      siteUrl: "https://example.com",
      language: "tr",
    });
  });
});

// ---- SC-F6: arka plan koşusu ----------------------------------------------------------

const LIVE = { features: { modes: true, live: true } };

const RESEARCH_ANSWER = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare pairs.",
  titleOptions: ["How to choose running shoes for your first race"],
  metaDescription: PLAN.metaDescription,
  outline: PLAN.outline,
};

// after()'a verilen geri çağrıyı tutar; test işi kendisi çalıştırır.
function capturedJob(): () => Promise<void> {
  const call = mocks.after.mock.calls[0]?.[0] as
    | (() => Promise<void>)
    | undefined;
  if (!call) throw new Error("no job was scheduled");
  return call;
}

describe("model calls in the background (SEO_ACTIONS)", () => {
  beforeEach(() => {
    mocks.run.mockResolvedValue({
      output: RESEARCH_ANSWER,
      isMock: false,
      reasoningCallId: "r",
    });
  });

  const brief = { topic: "Running shoes", siteUrl: "example.com", language: "tr" };

  it("bayrak açık ve kart canlı damgalıysa runId ile hemen döner, işi zamanlar", async () => {
    flagsOn("manager");
    row.card = card("brief", LIVE);

    const result = await researchSeoAction(PROJECT, CMD, brief);

    expect(result).toEqual({
      ok: true,
      message: "Working on it. This card updates live.",
      runId: expect.any(String),
    });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    // Sahiplik alındı ve ilk evre yazıldı; cevaptan sonra revalidate yok.
    expect(storedData().run).toMatchObject({
      kind: "research",
      phase: "researching",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    await capturedJob()();
    expect(stored().step).toBe("plan");
    expect(storedData().run).toBeUndefined();
    expect(storedData().plan).toMatchObject({ primaryKeyword: "running shoes" });
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, "w1", {
      summary: "Running shoes",
    });
  });

  it("bayrak kapalıyken damgalı kart da eşzamanlı yoldan gider", async () => {
    row.card = card("brief", LIVE);
    const result = await researchSeoAction(PROJECT, CMD, brief);
    expect(result).toEqual({
      ok: true,
      message: "Keywords and outline are ready.",
    });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(stored().step).toBe("plan");
  });

  it("damgasız (eski) kart bayrak açıkken de eşzamanlıdır", async () => {
    flagsOn("manager");
    const result = await researchSeoAction(PROJECT, CMD, brief);
    expect(result).toMatchObject({ ok: true, message: "Keywords and outline are ready." });
    expect(result.ok && result.runId).toBeUndefined();
  });

  it("sahte model reddi her şeyden önce gelir", async () => {
    flagsOn("manager");
    row.card = card("brief", LIVE);
    mocks.isMockMode.mockReturnValue(true);
    const result = await researchSeoAction(PROJECT, CMD, brief);
    expect(result).toMatchObject({ ok: false });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.updateModuleFlowCard).not.toHaveBeenCalled();
  });

  it("arka plan koşusu başarısız olursa kartı bırakır ve hatayı karta yazar", async () => {
    flagsOn("manager");
    row.card = card("brief", LIVE);
    mocks.run.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await researchSeoAction(PROJECT, CMD, brief);
    const runId = result.ok ? result.runId : undefined;
    await capturedJob()();

    expect(stored().step).toBe("brief");
    expect(storedData().run).toBeUndefined();
    expect(storedData().lastError).toMatchObject({
      runId,
      kind: "research",
      message: "Couldn't research this topic. Try again.",
    });
    spy.mockRestore();
  });

  it("yeni koşu önceki hatayı siler", async () => {
    flagsOn("manager");
    row.card = card("brief", {
      ...LIVE,
      lastError: {
        runId: "old",
        kind: "research",
        message: "old",
        at: NOW.toISOString(),
      },
    });
    await researchSeoAction(PROJECT, CMD, brief);
    expect(storedData().lastError).toBeUndefined();
  });

  it("geçmiş sonuçlar çağrıya girer", async () => {
    flagsOn("manager");
    mocks.readSeoLearnings.mockResolvedValue([
      "Rewriting titles to match searches raised click-through.",
    ]);
    await researchSeoAction(PROJECT, CMD, brief);
    expect(mocks.readSeoLearnings).toHaveBeenCalledWith(PROJECT, 5);
    const [, call] = mocks.run.mock.calls[0]!;
    expect(JSON.stringify(call)).toContain("Rewriting titles");
  });

  it("tazeleme kipinde sayfayı okuyup (reading_page) mevcut metinle yazar", async () => {
    flagsOn("loop");
    row.card = card("plan", {
      ...LIVE,
      mode: "refresh",
      brief: BRIEF,
      plan: PLAN,
      target: {
        url: "https://example.com/shoes",
        path: "/shoes",
        title: "Old shoes page",
        metaDescription: null,
        h1: null,
        h2: ["Old heading"],
        wordCount: 300,
        textHash: null,
        fetchedAt: NOW.toISOString(),
        queryCount: 0,
      },
      refresh: { missing: ["sizing chart"], keep: ["Old heading"] },
    });
    mocks.readTarget.mockResolvedValue({
      ok: true,
      target: {
        title: "Old shoes page",
        h2: ["Old heading"],
      },
      baseline: {},
      text: "The page as it stands today.",
    });
    mocks.run.mockResolvedValue({
      output: { markdown: `# New\n\n${MARKDOWN}`, title: "Fresh shoes", metaDescription: "Fresh meta." },
      isMock: false,
      reasoningCallId: "r",
    });

    const result = await writeSeoArticleAction(PROJECT, CMD);
    expect(result).toMatchObject({ ok: true, runId: expect.any(String) });
    expect(storedData().run).toMatchObject({ kind: "write", phase: "reading_page" });

    await capturedJob()();
    expect(mocks.readTarget).toHaveBeenCalledWith(
      PROJECT,
      "https://example.com/shoes",
      { textChars: 6000 },
    );
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call.context.mode).toBe("refresh");
    expect(call.context.facts.current).toMatchObject({
      title: "Old shoes page",
      text: "The page as it stands today.",
      missing: ["sizing chart"],
    });
    expect(stored().step).toBe("review");
    expect(storedData().article).toMatchObject({ title: "Fresh shoes" });
  });

  it("tazeleme kipinde sayfa okunamazsa yazma çağrısı yapılmaz", async () => {
    flagsOn("loop");
    row.card = card("plan", {
      ...LIVE,
      mode: "refresh",
      brief: BRIEF,
      plan: PLAN,
      target: {
        url: "https://example.com/shoes",
        path: "/shoes",
        title: null,
        metaDescription: null,
        h1: null,
        h2: [],
        wordCount: null,
        textHash: null,
        fetchedAt: NOW.toISOString(),
        queryCount: 0,
      },
    });
    mocks.readTarget.mockResolvedValue({ ok: false, message: "Couldn't read that page." });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeSeoArticleAction(PROJECT, CMD);
    await capturedJob()();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(storedData().lastError).toMatchObject({ message: "Couldn't read that page." });
    expect(stored().step).toBe("plan");
    spy.mockRestore();
  });
});

// ---- SC-F6: makalenin eylemi ----------------------------------------------------------------

describe("scheduleSeoArticleAction: ölçüm eylemi", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("deliver", { brief: BRIEF, plan: PLAN, article: ARTICLE });
    mocks.placeSeoArticle.mockResolvedValue({
      postId: "post-1",
      creativeId: "cr-1",
      scheduledFor: new Date(DELIVERY.scheduledFor),
      reused: false,
    });
  });

  const LOCALIZE_ACTION = {
    id: "fix-action",
    kind: "LOCALIZE",
    status: "ACCEPTED",
    proposal: {
      v: 1,
      kind: "LOCALIZE",
      title: "",
      primaryKeyword: "mavi aletler",
      language: null,
      liveUrl: null,
      note: null,
      alert: null,
    },
  };

  it("Fix this eylemi varsa AYNI eyleme yaratıcıyı bağlar, türü ve satırı değişmez", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      actionId: "fix-action",
    });
    mocks.getAction.mockResolvedValue(LOCALIZE_ACTION);

    expect(
      await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00"),
    ).toMatchObject({ ok: true });

    expect(mocks.attachCreative).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "fix-action",
      creativeId: "cr-1",
      nextCheckAt: new Date(DELIVERY.scheduledFor),
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.updateProposal).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "fix-action",
      proposal: expect.objectContaining({
        kind: "LOCALIZE",
        title: ARTICLE.title,
        language: BRIEF.language,
        primaryKeyword: "mavi aletler",
      }),
    });
  });

  it("eylemi olmayan makale kartı için NEW_CONTENT ACCEPTED açar, nextCheckAt = zamanlanan an", async () => {
    await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00");

    expect(mocks.createSeoAction).toHaveBeenCalledTimes(1);
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        projectId: PROJECT,
        kind: "NEW_CONTENT",
        source: "SEO_MANAGER",
        status: "ACCEPTED",
        openKey: `card:${CMD}`,
        creativeId: "cr-1",
        commandId: CMD,
        workId: "w1",
        nextCheckAt: new Date(DELIVERY.scheduledFor),
        proposal: expect.objectContaining({
          kind: "NEW_CONTENT",
          title: ARTICLE.title,
          primaryKeyword: "running shoes",
          language: "tr",
          liveUrl: null,
        }),
      }),
    );
    expect(storedData().actionId).toBe("new-action");
  });

  it("zamanlanan an geçmişteyse nextCheckAt şimdiye çekilir", async () => {
    mocks.placeSeoArticle.mockResolvedValue({
      postId: "post-1",
      creativeId: "cr-1",
      scheduledFor: new Date(NOW.getTime() - 60_000),
      reused: false,
    });
    await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-05T13:02");
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({ nextCheckAt: NOW }),
    );
  });

  it("tazeleme ve başlık kartlarında eylem açmaz", async () => {
    for (const mode of ["refresh", "snippet"]) {
      row.card = card("deliver", {
        mode,
        brief: BRIEF,
        plan: PLAN,
        article: ARTICLE,
      });
      await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00");
    }
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.attachCreative).not.toHaveBeenCalled();
  });

  it("açık olmayan (uygulanmış) eylemi yeniden bağlamaz", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      actionId: "fix-action",
    });
    mocks.getAction.mockResolvedValue({ ...LOCALIZE_ACTION, status: "APPLIED" });
    await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00");
    expect(mocks.attachCreative).not.toHaveBeenCalled();
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });

  it("eylem döngüsü kapalıyken hiçbir eylem çağrısı yapılmaz", async () => {
    delete process.env.SEO_CRAWL;
    await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00");
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.getAction).not.toHaveBeenCalled();
  });

  it("eylem kaydı hata verse de zamanlama başarılı sayılır", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createSeoAction.mockRejectedValue(new Error("db"));
    const result = await scheduleSeoArticleAction(PROJECT, CMD, "2026-10-09T10:00");
    expect(result).toMatchObject({ ok: true });
    expect(storedData().delivery).toEqual(DELIVERY);
    spy.mockRestore();
  });
});

describe("markSeoPublishedAction: canlı adres ve eylem", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
      actionId: "a1",
    });
    mocks.seoPieceStatus.mockResolvedValue("APPROVED");
    mocks.markCreativePublishedAction.mockResolvedValue({ ok: true });
    mocks.getAction.mockResolvedValue({
      id: "a1",
      kind: "NEW_CONTENT",
      status: "ACCEPTED",
      proposal: {
        v: 1,
        kind: "NEW_CONTENT",
        title: ARTICLE.title,
        primaryKeyword: "running shoes",
        language: "tr",
        liveUrl: null,
        note: null,
        alert: null,
      },
    });
  });

  it("geçerli canlı adres targetUrl ve proposal.liveUrl olarak işlenir, doğrulayıcı zamanlanır", async () => {
    const result = await markSeoPublishedAction(
      PROJECT,
      CMD,
      "example.com/blog/running-shoes",
    );
    expect(result).toEqual({ ok: true, message: "Marked as published." });
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "a1",
      event: "APPLY",
      userId: "u1",
      patch: {
        targetUrl: "https://example.com/blog/running-shoes",
        proposal: expect.objectContaining({
          liveUrl: "https://example.com/blog/running-shoes",
        }),
      },
    });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await capturedJob()();
    expect(mocks.runAction).toHaveBeenCalledWith("a1");
  });

  it("eş alan adındaki (www) adres köken alan adına çevrilir", async () => {
    await markSeoPublishedAction(PROJECT, CMD, "https://www.example.com/blog/x");
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          targetUrl: "https://example.com/blog/x",
        }),
      }),
    );
  });

  it("kapsam dışı adresi yok sayar, ama yine uygulandı yapar ve kullanıcıya söyler", async () => {
    const result = await markSeoPublishedAction(
      PROJECT,
      CMD,
      "https://other-site.com/post",
    );
    expect(result).toEqual({
      ok: true,
      message:
        "Marked as published. That address isn't on your verified site, so we'll look for the page ourselves.",
    });
    const call = mocks.transitionAction.mock.calls.find(
      ([input]) => input.event === "APPLY",
    )![0];
    expect(call.patch).toBeUndefined();
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("PROPOSED eylemi önce ACCEPTED yapar", async () => {
    mocks.getAction.mockResolvedValue({
      id: "a1",
      kind: "LOCALIZE",
      status: "PROPOSED",
      proposal: {
        v: 1,
        kind: "LOCALIZE",
        title: "",
        primaryKeyword: null,
        language: null,
        liveUrl: null,
        note: null,
        alert: null,
      },
    });
    await markSeoPublishedAction(PROJECT, CMD);
    expect(mocks.transitionAction.mock.calls.map(([i]) => i.event)).toEqual([
      "ACCEPT",
      "APPLY",
    ]);
  });

  it("eylem yoksa (bayraktan önce zamanlanmış) makale kartı için APPLIED açar", async () => {
    row.card = card("deliver", {
      brief: BRIEF,
      plan: PLAN,
      article: ARTICLE,
      delivery: DELIVERY,
    });
    mocks.getAction.mockResolvedValue(null);
    mocks.actionForCard.mockResolvedValue(null);

    await markSeoPublishedAction(PROJECT, CMD, "https://example.com/blog/x");
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "NEW_CONTENT",
        status: "APPLIED",
        openKey: `card:${CMD}`,
        creativeId: "cr-1",
        targetUrl: "https://example.com/blog/x",
      }),
    );
    expect(storedData().actionId).toBe("new-action");
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("eylem döngüsü kapalıyken yalnız bugünkü yayımlama yolu çalışır", async () => {
    delete process.env.SEO_ACTIONS;
    const result = await markSeoPublishedAction(PROJECT, CMD, "example.com/x");
    expect(result).toEqual({ ok: true, message: "Marked as published." });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.pageCheckSite).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
