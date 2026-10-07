import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// SEO Manager'ın kip eylemleri gerçek kart okuma/yazma ve arka plan sürücüsü
// üzerinden: kart bellekte bir satır (kart yazıcısının sahtesi), model
// çalıştırıcıları, sayfa okuyucu, eylem deposu ve doğrulayıcı sahte.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  after: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  commandFindFirst: vi.fn(),
  workFindFirst: vi.fn(),
  updateModuleFlowCard: vi.fn(),
  isMockMode: vi.fn(),
  workGet: vi.fn(),
  workTouch: vi.fn(),
  createSeoManagerCard: vi.fn(),
  readTarget: vi.fn(),
  pageQueriesForPrompt: vi.fn(),
  listTargetPages: vi.fn(),
  runSeoSnippet: vi.fn(),
  runSeoRefreshResearch: vi.fn(),
  readSeoLearnings: vi.fn(),
  getAction: vi.fn(),
  actionForCard: vi.fn(),
  createSeoAction: vi.fn(),
  updateProposal: vi.fn(),
  transitionAction: vi.fn(),
  requestCheckNow: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findFirst: mocks.commandFindFirst },
    work: { findFirst: mocks.workFindFirst },
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
  ReasoningService: { isMockMode: mocks.isMockMode },
}));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { get: mocks.workGet, touch: mocks.workTouch },
}));
vi.mock("@/server/modules/seo/new-card", () => ({
  createSeoManagerCard: mocks.createSeoManagerCard,
  SEO_MODE_TITLE: {
    article: "SEO Manager",
    refresh: "Refresh a page",
    snippet: "Fix the snippet",
  },
}));
vi.mock("@/server/modules/seo/target", () => ({
  readTarget: mocks.readTarget,
  pageQueriesForPrompt: mocks.pageQueriesForPrompt,
  listTargetPages: mocks.listTargetPages,
}));
vi.mock("@/server/modules/seo/snippet", () => ({
  runSeoSnippet: mocks.runSeoSnippet,
}));
vi.mock("@/server/modules/seo/refresh", () => ({
  runSeoRefreshResearch: mocks.runSeoRefreshResearch,
}));
vi.mock("@/server/seo/actions/learnings", () => ({
  readSeoLearnings: mocks.readSeoLearnings,
}));
vi.mock("@/server/seo/actions/store", () => ({
  getAction: mocks.getAction,
  actionForCard: mocks.actionForCard,
  createSeoAction: mocks.createSeoAction,
  updateProposal: mocks.updateProposal,
  transitionAction: mocks.transitionAction,
  requestCheckNow: mocks.requestCheckNow,
}));
vi.mock("@/server/seo/actions/verify", () => ({
  SeoActionVerifier: { runAction: mocks.runAction },
}));

import {
  checkSeoNowAction,
  chooseSnippetAction,
  confirmSeoLiveAction,
  markSeoAppliedAction,
  researchRefreshAction,
  seoTargetPagesAction,
  setSeoModeAction,
  startSeoCardAction,
  suggestSnippetAction,
  undoSeoAppliedAction,
} from "./seo-mode-actions";

const PROJECT = "p1";
const CMD = "cmd1";
const NOW = new Date("2026-10-07T10:00:00.000Z");
const SECRET_QUERY = "very secret search phrase";
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

const TARGET_URL = "https://example.com/shoes";
const LIVE = { features: { modes: true, live: true } };

const TARGET = {
  url: TARGET_URL,
  path: "/shoes",
  title: "Running shoes",
  metaDescription: "All about running shoes.",
  h1: "Running shoes",
  h2: ["Cushioning"],
  wordCount: 800,
  textHash: "abc",
  fetchedAt: NOW.toISOString(),
  queryCount: 4,
};

const BASELINE = {
  url: TARGET_URL,
  status: 200,
  title: "Running shoes",
  metaDescription: "All about running shoes.",
  h1: "Running shoes",
  h2: ["Cushioning"],
  canonical: TARGET_URL,
  noindex: false,
  indexable: true,
  wordCount: 800,
  textHash: "abc",
  schemaTypes: [],
  schemaErrors: 0,
  fetchedAt: NOW.toISOString(),
  source: "FETCH",
};

const VARIANTS = [
  { title: "Running shoes that fit", metaDescription: "Find your pair today.", angle: "benefit" },
  { title: "Which running shoes?", metaDescription: "A quick guide.", angle: "question" },
  { title: "Running shoes, tested", metaDescription: "We tried them all.", angle: "proof" },
];

const SNIPPET = {
  variants: VARIANTS,
  chosen: null,
  edited: null,
  generatedAt: NOW.toISOString(),
};

const REFRESH_PLAN = {
  primaryKeyword: "running shoes",
  secondaryKeywords: [],
  searchIntent: "commercial",
  intentNote: "",
  titleOptions: ["Running shoes, updated"],
  titleIndex: 0,
  metaDescription: "Updated guide.",
  outline: [{ h2: "Intro", points: ["a"] }],
  quickWins: { state: "not-connected" },
  researchedAt: NOW.toISOString(),
};

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

let row: { card: ModuleFlowCardData; workId: string | null };
let workStatus = "ACTIVE";
const stored = () => row.card;
// Testlerin okuduğu kart verisi alanları (saklanan JSON; çalışma anında denetlenmez).
type StoredData = {
  mode?: string;
  actionId?: string;
  pendingUrl?: string;
  applied?: unknown;
  run?: unknown;
  target?: { url: string; queryCount: number };
  snippet: { variants: unknown[]; chosen: number | null; edited: unknown };
  refresh?: unknown;
  plan?: { primaryKeyword: string };
};
const storedData = () => row.card.data as unknown as StoredData;

function capturedJob(): () => Promise<void> {
  const call = mocks.after.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  if (!call) throw new Error("no job was scheduled");
  return call;
}

const openAction = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  kind: "TITLE_META",
  status: "PROPOSED",
  proposal: {
    v: 1,
    kind: "TITLE_META",
    before: { title: "Running shoes", metaDescription: "All about running shoes." },
    after: null,
    variants: VARIANTS,
    note: null,
    alert: null,
  },
  ...overrides,
});

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
  mocks.updateModuleFlowCard.mockImplementation(
    async (input: {
      update: (
        current: ModuleFlowCardData,
      ) => ModuleFlowCardData | { reject: string };
    }) => {
      if (workStatus !== "ACTIVE") {
        return { ok: false, message: "This Work is completed. Reopen it to continue." };
      }
      const next = input.update(row.card);
      if ("reject" in next) return { ok: false, message: next.reject };
      row.card = next;
      return { ok: true, card: next };
    },
  );
  mocks.workGet.mockResolvedValue({ id: "w1", status: "ACTIVE" });
  mocks.workTouch.mockResolvedValue(undefined);
  mocks.createSeoManagerCard.mockResolvedValue({
    workId: "w1",
    commandId: "new-card",
    created: true,
  });
  mocks.readTarget.mockResolvedValue({
    ok: true,
    target: TARGET,
    baseline: BASELINE,
    text: "Page text",
  });
  mocks.pageQueriesForPrompt.mockResolvedValue([
    { text: SECRET_QUERY, impressions: 100, clicks: 4, position: 7 },
  ]);
  mocks.listTargetPages.mockResolvedValue([
    { url: TARGET_URL, path: "/shoes", clicks: 4, impressions: 100, source: "SEARCH" },
  ]);
  mocks.readSeoLearnings.mockResolvedValue([]);
  mocks.runSeoSnippet.mockResolvedValue({ ok: true, snippet: SNIPPET });
  mocks.runSeoRefreshResearch.mockResolvedValue({
    ok: true,
    plan: REFRESH_PLAN,
    refresh: { missing: ["sizing chart"], keep: ["Cushioning"] },
  });
  mocks.getAction.mockResolvedValue(null);
  mocks.actionForCard.mockResolvedValue(null);
  mocks.createSeoAction.mockResolvedValue({
    action: { id: "a-new" },
    created: true,
  });
  mocks.updateProposal.mockResolvedValue(true);
  mocks.transitionAction.mockResolvedValue({ ok: true, action: {} });
  mocks.requestCheckNow.mockResolvedValue("queued");
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

const UNAVAILABLE = "This isn't available for this project yet.";

describe("bayrak ve kip kapıları", () => {
  it("SEO_ACTIONS kapalıyken hiçbir eylem çalışmaz", async () => {
    const results = await Promise.all([
      startSeoCardAction(PROJECT, "w1", "article"),
      setSeoModeAction(PROJECT, CMD, "article"),
      seoTargetPagesAction(PROJECT),
      suggestSnippetAction(PROJECT, CMD, {}),
      chooseSnippetAction(PROJECT, CMD, {}),
      researchRefreshAction(PROJECT, CMD, {}),
      markSeoAppliedAction(PROJECT, CMD),
      confirmSeoLiveAction(PROJECT, CMD),
      checkSeoNowAction(PROJECT, CMD),
      undoSeoAppliedAction(PROJECT, CMD),
    ]);
    for (const result of results) {
      expect(result).toEqual({ ok: false, message: UNAVAILABLE });
    }
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.createSeoManagerCard).not.toHaveBeenCalled();
  });

  it("yalnız manager() açıkken makale kartı açılır, refresh/snippet açılmaz", async () => {
    flagsOn("manager");
    expect(await startSeoCardAction(PROJECT, "w1", "article")).toMatchObject({
      ok: true,
    });
    expect(await startSeoCardAction(PROJECT, "w1", "snippet")).toEqual({
      ok: false,
      message: UNAVAILABLE,
    });
    expect(await startSeoCardAction(PROJECT, "w1", "refresh")).toEqual({
      ok: false,
      message: UNAVAILABLE,
    });
    expect(await suggestSnippetAction(PROJECT, CMD, {})).toEqual({
      ok: false,
      message: UNAVAILABLE,
    });
    expect(await researchRefreshAction(PROJECT, CMD, {})).toEqual({
      ok: false,
      message: UNAVAILABLE,
    });
    expect(await seoTargetPagesAction(PROJECT)).toEqual({
      ok: false,
      message: UNAVAILABLE,
    });
  });

  it("izin listesinde olmayan projede refresh/snippet açılmaz", async () => {
    flagsOn("loop");
    const previous = process.env.SEO_ROLLOUT_PROJECTS;
    process.env.SEO_ROLLOUT_PROJECTS = "someone-else";
    try {
      expect(await startSeoCardAction(PROJECT, "w1", "snippet")).toEqual({
        ok: false,
        message: UNAVAILABLE,
      });
    } finally {
      if (previous === undefined) delete process.env.SEO_ROLLOUT_PROJECTS;
      else process.env.SEO_ROLLOUT_PROJECTS = previous;
    }
  });

  it("geçersiz kip adını reddeder", async () => {
    flagsOn("loop");
    expect(await startSeoCardAction(PROJECT, "w1", "bogus")).toMatchObject({
      ok: false,
    });
    expect(mocks.createSeoManagerCard).not.toHaveBeenCalled();
  });
});

describe("startSeoCardAction", () => {
  it("aynı Work'te HER ZAMAN yeni kart açar ve Work'ü günceller", async () => {
    flagsOn("loop");
    const first = await startSeoCardAction(PROJECT, "w1", "refresh");
    const second = await startSeoCardAction(PROJECT, "w1", "refresh");
    expect(first).toEqual({ ok: true, commandId: "new-card" });
    expect(second).toEqual({ ok: true, commandId: "new-card" });
    expect(mocks.createSeoManagerCard).toHaveBeenCalledTimes(2);
    expect(mocks.createSeoManagerCard).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "refresh",
        userId: "u1",
        work: { existingId: "w1" },
        scope: { workspaceId: "ws1", projectId: PROJECT, brandId: "b1" },
      }),
    );
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, "w1", {
      summary: "Refresh a page",
    });
  });

  it("tamamlanmış ya da bilinmeyen Work'ü reddeder", async () => {
    flagsOn("loop");
    mocks.workGet.mockResolvedValueOnce({ id: "w1", status: "COMPLETED" });
    expect(await startSeoCardAction(PROJECT, "w1", "article")).toEqual({
      ok: false,
      message: "This Work is completed. Reopen it to continue.",
    });
    mocks.workGet.mockResolvedValueOnce(null);
    expect(await startSeoCardAction(PROJECT, "nope", "article")).toMatchObject({
      ok: false,
    });
    expect(mocks.createSeoManagerCard).not.toHaveBeenCalled();
  });
});

describe("setSeoModeAction", () => {
  it("taze kartın kipini değiştirir ve eski hedefi bırakır", async () => {
    flagsOn("loop");
    row.card = card("brief", { mode: "refresh", pendingUrl: TARGET_URL });
    expect(await setSeoModeAction(PROJECT, CMD, "snippet")).toEqual({ ok: true });
    expect(storedData().mode).toBe("snippet");
    expect(storedData().pendingUrl).toBeUndefined();
  });

  it("ilerlemiş karta dokunmaz", async () => {
    flagsOn("loop");
    row.card = card("plan", { mode: "snippet", snippet: SNIPPET, target: TARGET });
    expect(await setSeoModeAction(PROJECT, CMD, "refresh")).toMatchObject({
      ok: false,
      code: "STALE",
    });
    expect(storedData().mode).toBe("snippet");
  });
});

describe("seoTargetPagesAction", () => {
  it("seçilebilir sayfaları döndürür", async () => {
    flagsOn("loop");
    expect(await seoTargetPagesAction(PROJECT)).toEqual({
      ok: true,
      pages: [
        { url: TARGET_URL, path: "/shoes", clicks: 4, impressions: 100, source: "SEARCH" },
      ],
    });
  });
});

describe("suggestSnippetAction", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("brief", { mode: "snippet" });
  });

  const input = { url: TARGET_URL, language: "en" };

  it("sayfayı okur, varyantları üretir, TITLE_META PROPOSED açar; kartta sorgu metni yok", async () => {
    const result = await suggestSnippetAction(PROJECT, CMD, input);
    expect(result).toEqual({ ok: true, message: "Three new titles are ready." });

    expect(mocks.readTarget).toHaveBeenCalledWith(PROJECT, TARGET_URL);
    // Model çağrısına konu olarak sayfanın başlığı ve sorgu özeti gider.
    expect(mocks.runSeoSnippet).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: {
          topic: "Running shoes",
          siteUrl: "https://example.com",
          language: "en",
          audience: "",
        },
        target: TARGET,
        queries: [{ text: SECRET_QUERY, impressions: 100, clicks: 4, position: 7 }],
        learnings: [],
      }),
    );

    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        projectId: PROJECT,
        kind: "TITLE_META",
        source: "SEO_MANAGER",
        status: "PROPOSED",
        openKey: `card:${CMD}`,
        targetUrl: TARGET_URL,
        baseline: BASELINE,
        commandId: CMD,
        workId: "w1",
        userId: "u1",
        proposal: expect.objectContaining({
          kind: "TITLE_META",
          before: {
            title: "Running shoes",
            metaDescription: "All about running shoes.",
          },
          after: null,
          variants: VARIANTS,
        }),
      }),
    );

    expect(stored().step).toBe("plan");
    expect(storedData()).toMatchObject({
      mode: "snippet",
      target: { url: TARGET_URL, queryCount: 4 },
      snippet: { variants: VARIANTS, chosen: null },
      actionId: "a-new",
    });
    expect(storedData().run).toBeUndefined();
    expect(storedData().pendingUrl).toBeUndefined();
    expect(JSON.stringify(stored())).not.toContain(SECRET_QUERY);
    expect(mocks.workTouch).toHaveBeenCalledWith(PROJECT, "w1", {
      summary: "Running shoes",
    });
  });

  it("kartın eylemi varsa yenisini açmaz, önerisini yeniler", async () => {
    row.card = card("plan", { mode: "snippet", actionId: "a1", snippet: SNIPPET, target: TARGET });
    mocks.getAction.mockResolvedValue(
      openAction({
        status: "ACCEPTED",
        proposal: { ...openAction().proposal, note: "my note" },
      }),
    );
    await suggestSnippetAction(PROJECT, CMD, input);
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.updateProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        actionId: "a1",
        targetUrl: TARGET_URL,
        baseline: BASELINE,
        proposal: expect.objectContaining({ after: null, note: "my note" }),
      }),
    );
    expect(storedData().actionId).toBe("a1");
  });

  it("SEO_ACTIONS ve canlı damga varsa arka planda koşar", async () => {
    row.card = card("brief", { mode: "snippet", ...LIVE });
    const result = await suggestSnippetAction(PROJECT, CMD, input);
    expect(result).toMatchObject({ ok: true, runId: expect.any(String) });
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(storedData().run).toMatchObject({ kind: "snippet", phase: "reading_page" });
    expect(storedData().pendingUrl).toBe(TARGET_URL);

    await capturedJob()();
    expect(stored().step).toBe("plan");
    expect(storedData().snippet.variants).toHaveLength(3);
  });

  it("geçersiz adres ve dili, makale kipini ve sahte modeli claim'den önce reddeder", async () => {
    expect(await suggestSnippetAction(PROJECT, CMD, { url: "nope", language: "en" })).toMatchObject({ ok: false });
    expect(await suggestSnippetAction(PROJECT, CMD, { url: TARGET_URL, language: "xx" })).toMatchObject({ ok: false });
    row.card = card("brief", { mode: "article" });
    expect(await suggestSnippetAction(PROJECT, CMD, input)).toMatchObject({ ok: false, code: "STALE" });
    row.card = card("brief", { mode: "snippet" });
    mocks.isMockMode.mockReturnValue(true);
    expect(await suggestSnippetAction(PROJECT, CMD, input)).toMatchObject({ ok: false });
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(mocks.updateModuleFlowCard).not.toHaveBeenCalled();
  });

  it("sayfa okunamazsa Brief'e döner ve iletiyi söyler", async () => {
    mocks.readTarget.mockResolvedValue({ ok: false, message: "Couldn't read that page." });
    const result = await suggestSnippetAction(PROJECT, CMD, input);
    expect(result).toEqual({ ok: false, message: "Couldn't read that page." });
    expect(stored().step).toBe("brief");
    expect(storedData().run).toBeUndefined();
    expect(mocks.runSeoSnippet).not.toHaveBeenCalled();
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });

  it("eylem kaydı hata verse de varyantlar karta yazılır", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createSeoAction.mockRejectedValue(new Error("db"));
    const result = await suggestSnippetAction(PROJECT, CMD, input);
    expect(result).toMatchObject({ ok: true });
    expect(storedData().snippet.variants).toHaveLength(3);
    expect(storedData().actionId).toBeUndefined();
    spy.mockRestore();
  });
});

describe("chooseSnippetAction", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("plan", {
      mode: "snippet",
      target: TARGET,
      snippet: SNIPPET,
      actionId: "a1",
    });
    mocks.getAction.mockResolvedValue(openAction());
  });

  it("varyantı seçer, Deliver'a geçer ve eylemi seçilen metinle ACCEPT eder", async () => {
    const result = await chooseSnippetAction(PROJECT, CMD, { index: 1 });
    expect(result).toMatchObject({ ok: true });
    expect(stored().step).toBe("deliver");
    expect(storedData().snippet).toMatchObject({ chosen: 1, edited: null });
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "a1",
      event: "ACCEPT",
      userId: "u1",
      patch: {
        proposal: expect.objectContaining({
          after: { title: VARIANTS[1]!.title, metaDescription: VARIANTS[1]!.metaDescription },
        }),
      },
    });
  });

  it("kullanıcının düzelttiği metni edited olarak saklar ve after'a yazar", async () => {
    await chooseSnippetAction(PROJECT, CMD, {
      index: 0,
      edited: { title: "My own title", metaDescription: "My own description." },
    });
    expect(storedData().snippet).toMatchObject({
      chosen: 0,
      edited: { title: "My own title", metaDescription: "My own description." },
    });
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: {
          proposal: expect.objectContaining({
            after: { title: "My own title", metaDescription: "My own description." },
          }),
        },
      }),
    );
  });

  it("varyantla aynı olan düzeltmeyi edited saymaz", async () => {
    await chooseSnippetAction(PROJECT, CMD, {
      index: 2,
      edited: { title: VARIANTS[2]!.title, metaDescription: VARIANTS[2]!.metaDescription },
    });
    expect(storedData().snippet.edited).toBeNull();
  });

  it("SNIPPET_LIMITS üst sınırını aşan başlığı ve açıklamayı reddeder", async () => {
    const longTitle = "x".repeat(71);
    const longMeta = "y".repeat(171);
    expect(
      await chooseSnippetAction(PROJECT, CMD, {
        index: 0,
        edited: { title: longTitle, metaDescription: "ok" },
      }),
    ).toEqual({ ok: false, message: "The title can be at most 70 characters." });
    expect(
      await chooseSnippetAction(PROJECT, CMD, {
        index: 0,
        edited: { title: "ok", metaDescription: longMeta },
      }),
    ).toEqual({ ok: false, message: "The description can be at most 170 characters." });
    expect(
      await chooseSnippetAction(PROJECT, CMD, {
        index: 0,
        edited: { title: "  ", metaDescription: "ok" },
      }),
    ).toEqual({ ok: false, message: "Add a title." });
    expect(stored().step).toBe("plan");
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });

  it("geçersiz sıra, yanlış adım ve uygulanmış kartı reddeder", async () => {
    expect(await chooseSnippetAction(PROJECT, CMD, { index: 7 })).toMatchObject({ ok: false });
    expect(await chooseSnippetAction(PROJECT, CMD, {})).toMatchObject({ ok: false });
    row.card = card("deliver", { mode: "snippet", snippet: { ...SNIPPET, chosen: 0 } });
    expect(await chooseSnippetAction(PROJECT, CMD, { index: 1 })).toMatchObject({ ok: false, code: "STALE" });
  });

  it("eylem yoksa ACCEPTED olarak açar ve kartın actionId'sine yazar", async () => {
    row.card = card("plan", { mode: "snippet", target: TARGET, snippet: SNIPPET });
    mocks.getAction.mockResolvedValue(null);
    await chooseSnippetAction(PROJECT, CMD, { index: 0 });
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TITLE_META",
        status: "ACCEPTED",
        openKey: `card:${CMD}`,
        proposal: expect.objectContaining({
          after: { title: VARIANTS[0]!.title, metaDescription: VARIANTS[0]!.metaDescription },
        }),
      }),
    );
    expect(storedData().actionId).toBe("a-new");
  });
});

describe("researchRefreshAction", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("brief", { mode: "refresh" });
  });

  it("sayfayı okur, araştırır, CONTENT_REFRESH PROPOSED açar ve Plan'a geçer", async () => {
    const result = await researchRefreshAction(PROJECT, CMD, {
      url: TARGET_URL,
      language: "en",
    });
    expect(result).toEqual({ ok: true, message: "The page is researched. Review the plan." });
    expect(mocks.readTarget).toHaveBeenCalledWith(PROJECT, TARGET_URL, { textChars: 6000 });
    expect(mocks.runSeoRefreshResearch).toHaveBeenCalledWith(
      expect.objectContaining({ pageText: "Page text", target: TARGET }),
    );
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CONTENT_REFRESH",
        status: "PROPOSED",
        openKey: `card:${CMD}`,
        baseline: BASELINE,
        proposal: expect.objectContaining({
          kind: "CONTENT_REFRESH",
          primaryKeyword: "running shoes",
          missing: ["sizing chart"],
        }),
      }),
    );
    expect(stored().step).toBe("plan");
    expect(storedData()).toMatchObject({
      refresh: { missing: ["sizing chart"], keep: ["Cushioning"] },
      plan: { primaryKeyword: "running shoes" },
      actionId: "a-new",
    });
    expect(JSON.stringify(stored())).not.toContain(SECRET_QUERY);
  });

  it("snippet kartında çalışmaz", async () => {
    row.card = card("brief", { mode: "snippet" });
    expect(
      await researchRefreshAction(PROJECT, CMD, { url: TARGET_URL, language: "en" }),
    ).toMatchObject({ ok: false, code: "STALE" });
  });
});

describe("markSeoAppliedAction", () => {
  beforeEach(() => {
    flagsOn("loop");
  });

  it("başlık kartı: ACCEPTED eylemi seçilen metinle APPLY eder, kartı kilitler, doğrulayıcıyı zamanlar", async () => {
    row.card = card("deliver", {
      mode: "snippet",
      target: TARGET,
      snippet: { ...SNIPPET, chosen: 1 },
      actionId: "a1",
    });
    mocks.getAction.mockResolvedValue(openAction({ status: "ACCEPTED" }));

    const result = await markSeoAppliedAction(PROJECT, CMD);
    expect(result).toEqual({
      ok: true,
      message: "Marked as applied. We'll check your page.",
    });
    expect(mocks.transitionAction).toHaveBeenCalledTimes(1);
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "a1",
      event: "APPLY",
      userId: "u1",
      patch: {
        proposal: expect.objectContaining({
          after: { title: VARIANTS[1]!.title, metaDescription: VARIANTS[1]!.metaDescription },
        }),
      },
    });
    expect(storedData().applied).toEqual({ at: NOW.toISOString() });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await capturedJob()();
    expect(mocks.runAction).toHaveBeenCalledWith("a1");
  });

  it("PROPOSED eylem önce ACCEPT edilir", async () => {
    row.card = card("deliver", {
      mode: "snippet",
      snippet: { ...SNIPPET, chosen: 0 },
      actionId: "a1",
    });
    mocks.getAction.mockResolvedValue(openAction());
    await markSeoAppliedAction(PROJECT, CMD);
    expect(mocks.transitionAction.mock.calls.map(([i]) => i.event)).toEqual([
      "ACCEPT",
      "APPLY",
    ]);
  });

  it("tazeleme kartı: yazılan makalenin başlığı ve uzunluğu proposal.after olur", async () => {
    row.card = card("deliver", {
      mode: "refresh",
      target: TARGET,
      plan: REFRESH_PLAN,
      article: {
        title: "Running shoes, updated",
        metaDescription: "A newer description.",
        markdown: "one two three four five",
        writtenAt: NOW.toISOString(),
        rewrites: 0,
      },
      actionId: "a2",
    });
    mocks.getAction.mockResolvedValue({
      id: "a2",
      kind: "CONTENT_REFRESH",
      status: "ACCEPTED",
      proposal: {
        v: 1,
        kind: "CONTENT_REFRESH",
        primaryKeyword: "running shoes",
        missing: [],
        after: null,
        note: null,
        alert: null,
      },
    });
    await markSeoAppliedAction(PROJECT, CMD);
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "APPLY",
        patch: {
          proposal: expect.objectContaining({
            after: {
              title: "Running shoes, updated",
              metaDescription: "A newer description.",
              wordCount: 5,
            },
          }),
        },
      }),
    );
  });

  it("eylem yoksa APPLIED olarak açar ve actionId'yi karta yazar", async () => {
    row.card = card("deliver", {
      mode: "snippet",
      target: TARGET,
      snippet: { ...SNIPPET, chosen: 0 },
    });
    await markSeoAppliedAction(PROJECT, CMD);
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TITLE_META",
        status: "APPLIED",
        openKey: `card:${CMD}`,
        targetUrl: TARGET_URL,
      }),
    );
    expect(storedData().actionId).toBe("a-new");
    expect(storedData().applied).toBeDefined();
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("iki kez dokunulursa ikinci kez uygulamaz", async () => {
    row.card = card("deliver", {
      mode: "snippet",
      snippet: { ...SNIPPET, chosen: 0 },
      applied: { at: NOW.toISOString() },
      actionId: "a1",
    });
    const result = await markSeoAppliedAction(PROJECT, CMD);
    expect(result).toMatchObject({ ok: true });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("makale kipinde ve Deliver dışında reddeder", async () => {
    row.card = card("deliver", { mode: "article" });
    expect(await markSeoAppliedAction(PROJECT, CMD)).toMatchObject({ ok: false, code: "STALE" });
    row.card = card("plan", { mode: "snippet" });
    expect(await markSeoAppliedAction(PROJECT, CMD)).toMatchObject({ ok: false, code: "STALE" });
  });

  it("eylem geçişi reddedilirse kartı kilitlemez", async () => {
    row.card = card("deliver", {
      mode: "snippet",
      snippet: { ...SNIPPET, chosen: 0 },
      actionId: "a1",
    });
    mocks.getAction.mockResolvedValue(openAction({ status: "ACCEPTED" }));
    mocks.transitionAction.mockResolvedValue({ ok: false, reason: "invalid_transition" });
    expect(await markSeoAppliedAction(PROJECT, CMD)).toMatchObject({ ok: false });
    expect(storedData().applied).toBeUndefined();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe("confirmSeoLiveAction, checkSeoNowAction, undoSeoAppliedAction", () => {
  beforeEach(() => {
    flagsOn("loop");
    row.card = card("deliver", {
      mode: "snippet",
      snippet: { ...SNIPPET, chosen: 0 },
      applied: { at: NOW.toISOString() },
      actionId: "a1",
    });
    mocks.getAction.mockResolvedValue(openAction({ status: "APPLIED" }));
  });

  it("'It's live' CONFIRM_LIVE geçişini yapar", async () => {
    expect(await confirmSeoLiveAction(PROJECT, CMD)).toEqual({
      ok: true,
      message: "Got it. We'll measure from here.",
    });
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "a1",
      event: "CONFIRM_LIVE",
      userId: "u1",
    });
  });

  it("geçiş geçersizse kartı yenilemeye çağırır", async () => {
    mocks.transitionAction.mockResolvedValue({ ok: false, reason: "invalid_transition" });
    expect(await confirmSeoLiveAction(PROJECT, CMD)).toMatchObject({ ok: false });
  });

  it("'Check now' kuyruğa alır ve doğrulayıcıyı zamanlar; çok sıkışıksa zamanlamaz", async () => {
    expect(await checkSeoNowAction(PROJECT, CMD)).toEqual({
      ok: true,
      message: "We'll check your page shortly.",
    });
    expect(mocks.requestCheckNow).toHaveBeenCalledWith(PROJECT, "a1");
    expect(mocks.after).toHaveBeenCalledTimes(1);

    mocks.after.mockClear();
    mocks.requestCheckNow.mockResolvedValue("too_soon");
    expect(await checkSeoNowAction(PROJECT, CMD)).toEqual({
      ok: true,
      message: "We just checked. Try again in a few minutes.",
    });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("'Not done yet' UNDO_APPLY yapar ve kartın applied işaretini kaldırır", async () => {
    expect(await undoSeoAppliedAction(PROJECT, CMD)).toEqual({
      ok: true,
      message: "Back to to-do.",
    });
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: PROJECT,
      actionId: "a1",
      event: "UNDO_APPLY",
      userId: "u1",
    });
    expect(storedData().applied).toBeUndefined();
  });

  it("kartın eylemi yoksa söyler", async () => {
    mocks.getAction.mockResolvedValue(null);
    mocks.actionForCard.mockResolvedValue(null);
    for (const action of [confirmSeoLiveAction, checkSeoNowAction, undoSeoAppliedAction]) {
      expect(await action(PROJECT, CMD)).toEqual({
        ok: false,
        message: "There is nothing to update here yet.",
      });
    }
  });

  it("başka projenin kartına dokunmaz", async () => {
    expect(await confirmSeoLiveAction("other-project", CMD)).toMatchObject({ ok: false });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });
});
