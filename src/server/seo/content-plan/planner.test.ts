import type { GscSiteLink } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keywordKey } from "@/lib/seo/content-plan/doorway";
import {
  planDataFixture,
  planInputFixture,
  slotFixture,
} from "@/lib/seo/content-plan/test-support";
import type {
  PlanCandidate,
  PlanSlot,
  SeoContentPlanData,
} from "@/lib/seo/content-plan/types";
import { parseContentPlanData } from "@/lib/seo/content-plan/types";

// Bu dosyanın kanıtladığı: sınır özelliği (cap 1..12 x mevcut 0..16: slot sayısı
// <= max(0, cap - mevcut)) ve işlem içi yeniden sayımın kırpması; EMPTY
// sonuçlar EMPTY satır yazar ve parça yazmaz; bütçe kuralı (otomatik + ayın ilk
// 5 günü -> AI_LIMIT + retry BUDGET, sonrası BASIC + wordingNote); ikinci çağrı
// "exists"; mock bağ + küresel iş yok -> "off"; P2034 iki kez -> BUSY; P2002 ->
// exists; havuz fikri yeniden kullanımı; Skip/Move/Refresh kuralları (yazılmış
// ya da etkin kartlı slota dokunulmaz, 3 yenileme sınırı, 'behind' hiçbir şeyi
// değiştirmez). Bellekte basit bir veritabanı taklidiyle çalışır.

type CreativeRow = {
  id: string;
  projectId: string;
  status: string;
  planId: string | null;
  postId: string | null;
  scheduledFor: Date | null;
  formatKey: string | null;
  versions: number;
};
type IdeaRow = {
  id: string;
  projectId: string;
  status: string;
  concept: unknown;
  title?: string;
};

type World = {
  row: Record<string, unknown> | null;
  setting: { monthlyCap: number; autoPlan: boolean } | null;
  creatives: Map<string, CreativeRow>;
  posts: Map<string, { id: string; archivedAt: Date | null; ideaId: string | null; scheduledFor: Date | null }>;
  ideas: Map<string, IdeaRow>;
  baseCount: number;
  cards: { workId: string | null; parsedIntent: unknown }[];
  txFailures: unknown[];
  txRuns: number;
  seq: number;
  poolClaimCount: number | null;
};

const mocks = vi.hoisted(() => ({
  loadPlanInput: vi.fn(),
  writeWording: vi.fn(),
  buildCandidates: vi.fn(),
  isModulesEnabled: vi.fn(),
  primaryGscLink: vi.fn(),
  record: vi.fn(),
  prisma: {} as Record<string, unknown>,
  world: null as unknown as { current: World },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("./inputs", () => ({ loadPlanInput: mocks.loadPlanInput }));
vi.mock("./wording", () => ({ writeWording: mocks.writeWording }));
vi.mock("@/lib/seo/content-plan/candidates", () => ({
  buildCandidates: mocks.buildCandidates,
}));
vi.mock("@/server/works/flag", () => ({ isModulesEnabled: mocks.isModulesEnabled }));
vi.mock("@/server/seo/store", () => ({ primaryGscLink: mocks.primaryGscLink }));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
}));
vi.mock("@/server/seo/opportunities/state", () => ({ readEngineState: vi.fn() }));
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    readPlanRow: async () => mocks.world.current.row,
    readPlanSettings: async () => {
      const setting = mocks.world.current.setting;
      return setting ?? { monthlyCap: 4, autoPlan: true };
    },
    projectTimezone: async () => "Europe/Istanbul",
  };
});

const { createMonthlyPlan, skipSlot, moveSlot, regenerateContentPlan } =
  await import("./planner");

const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "GSC_ROLLOUT_PROJECTS",
  "GSC_SYNC_DEV_PROJECTS",
  "DATABASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// 7 Ekim 2026 12:00 İstanbul: ayın 7'si, plan penceresi açık.
const NOW = new Date("2026-10-07T09:00:00Z");
const EARLY = new Date("2026-10-03T09:00:00Z");

function link(overrides: Partial<GscSiteLink> = {}): GscSiteLink {
  return {
    id: "link-1",
    projectId: "p1",
    workspaceId: "w1",
    isMock: false,
    lastWeeklyWeek: "2026-09-28",
    ...overrides,
  } as GscSiteLink;
}

function newWorld(): World {
  return {
    row: null,
    setting: null,
    creatives: new Map(),
    posts: new Map(),
    ideas: new Map(),
    baseCount: 0,
    cards: [],
    txFailures: [],
    txRuns: 0,
    seq: 0,
    poolClaimCount: null,
  };
}

function untouched(row: CreativeRow): boolean {
  return row.status === "DRAFT" && row.planId === null && row.versions === 0;
}

function buildTx(world: World) {
  const id = (prefix: string) => `${prefix}-${++world.seq}`;
  const countable = () =>
    [...world.creatives.values()].filter(
      (row) =>
        row.formatKey === "seo.article" &&
        row.status !== "ARCHIVED" &&
        row.status !== "REJECTED",
    ).length;
  return {
    seoContentPlan: {
      findUnique: vi.fn(async () => world.row),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (world.row) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        world.row = { id: "plan-1", regenerations: 0, ...args.data };
        return { id: "plan-1" };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        world.row = { ...world.row!, ...args.data };
        return { id: "plan-1" };
      }),
    },
    seoContentSetting: { findUnique: vi.fn(async () => world.setting) },
    creative: {
      count: vi.fn(async () => world.baseCount + countable()),
      findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
        [...world.creatives.values()]
          .filter((row) => (args.where.id?.in ?? []).includes(row.id) && untouched(row))
          .map((row) => ({ id: row.id, postId: row.postId, scheduledFor: row.scheduledFor })),
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row: CreativeRow = {
          id: id("creative"),
          projectId: args.data.projectId as string,
          status: args.data.status as string,
          planId: (args.data.planId as string | null) ?? null,
          postId: (args.data.postId as string | null) ?? null,
          scheduledFor: args.data.scheduledFor as Date,
          formatKey: (args.data.formatKey as string | null) ?? null,
          versions: 0,
        };
        world.creatives.set(row.id, row);
        return { id: row.id };
      }),
      updateMany: vi.fn(
        async (args: { where: { id: { in: string[] } }; data: { status?: string } }) => {
          let count = 0;
          for (const row of world.creatives.values()) {
            if (args.where.id.in.includes(row.id) && untouched(row)) {
              if (args.data.status) row.status = args.data.status;
              count += 1;
            }
          }
          return { count };
        },
      ),
      update: vi.fn(async (args: { where: { id: string }; data: { scheduledFor?: Date } }) => {
        const row = world.creatives.get(args.where.id)!;
        if (args.data.scheduledFor) row.scheduledFor = args.data.scheduledFor;
        return { id: row.id };
      }),
    },
    post: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const post = {
          id: id("post"),
          archivedAt: null,
          ideaId: (args.data.ideaId as string | null) ?? null,
          scheduledFor: args.data.scheduledFor as Date,
        };
        world.posts.set(post.id, post);
        return { id: post.id };
      }),
      updateMany: vi.fn(
        async (args: {
          where: { id: string | { in: string[] } };
          data: { archivedAt?: Date; scheduledFor?: Date };
        }) => {
          const ids = typeof args.where.id === "string" ? [args.where.id] : args.where.id.in;
          for (const postId of ids) {
            const post = world.posts.get(postId);
            if (!post) continue;
            if (args.data.archivedAt) post.archivedAt = args.data.archivedAt;
            if (args.data.scheduledFor) post.scheduledFor = args.data.scheduledFor;
          }
          return { count: ids.length };
        },
      ),
    },
    idea: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const idea: IdeaRow = {
          id: id("idea"),
          projectId: args.data.projectId as string,
          status: args.data.status as string,
          concept: args.data.concept,
          title: args.data.title as string,
        };
        world.ideas.set(idea.id, idea);
        return { id: idea.id };
      }),
      findFirst: vi.fn(
        async (args: { where: { id: string; status?: string | { in: string[] } } }) => {
          const idea = world.ideas.get(args.where.id);
          if (!idea) return null;
          const wanted = args.where.status;
          if (typeof wanted === "string" && idea.status !== wanted) return null;
          if (wanted && typeof wanted === "object" && !wanted.in.includes(idea.status)) {
            return null;
          }
          return { id: idea.id, status: idea.status, concept: idea.concept };
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; status?: string };
          data: { status: string; concept?: unknown };
        }) => {
          const idea = world.ideas.get(args.where.id);
          if (!idea) return { count: 0 };
          if (args.where.status && idea.status !== args.where.status) return { count: 0 };
          if (world.poolClaimCount === 0 && args.data.status === "PLANNING") {
            return { count: 0 };
          }
          idea.status = args.data.status;
          if (args.data.concept !== undefined) idea.concept = args.data.concept;
          return { count: 1 };
        },
      ),
    },
    command: { findMany: vi.fn(async () => world.cards) },
  };
}

function installPrisma(world: World) {
  const tx = buildTx(world);
  const prisma = mocks.prisma as Record<string, unknown>;
  for (const key of Object.keys(prisma)) delete prisma[key];
  Object.assign(prisma, {
    seoContentPlan: tx.seoContentPlan,
    creative: tx.creative,
    command: tx.command,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      world.txRuns += 1;
      const failure = world.txFailures.shift();
      if (failure) throw failure;
      return fn(tx);
    }),
  });
  return tx;
}

function wordOf(index: number): string {
  // Birbirinden ayrışık, rakamsız sahte sözcükler (Jaccard 0).
  const letters = "bcdfghjklmnpqrstvwxz";
  return `zor${letters[index % letters.length]}${letters[Math.floor(index / letters.length)]}ax`;
}

function candidatesOf(count: number, overrides: Partial<PlanCandidate> = {}): PlanCandidate[] {
  return Array.from({ length: count }, (_, i) => {
    const keyword = `${wordOf(i)} guide`;
    return {
      id: `SUPPORT:c${i}:${keyword}`,
      kind: "SUPPORT" as const,
      clusterId: `c${i}`,
      clusterName: `Cluster ${i}`,
      keyword,
      queries: [`${wordOf(i)} how`],
      queryIds: [`q${i}`],
      intent: "informational" as const,
      impressions: 1000 - i,
      clicks: 0,
      share: 0.02,
      position: 30,
      gap: "NO_PAGE" as const,
      rising: false,
      findingId: null,
      findingConfidence: null,
      score: 1 - i / 100,
      bestPageId: null,
      reuseIdeaId: null,
      ...overrides,
    };
  });
}

let world: World;

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    input: planInputFixture({ week: "2026-09-28", clusters: [], existingTitles: [], existingKeywords: [] }),
    link: link(),
    scope: { workspaceId: "w1", projectId: "p1", brandId: "b1" },
    existingInMonth: 0,
    takenDates: [] as string[],
    language: "en",
    ...overrides,
  };
}

function plannedSlotsOf(): PlanSlot[] {
  return parseContentPlanData(world.row!.data).slots;
}

function dataOf(): SeoContentPlanData {
  return parseContentPlanData(world.row!.data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SEO_CONTENT_PLAN = "true";
  process.env.GSC_SYNC = "true";
  process.env.SEO_INSIGHTS = "on";
  process.env.GSC_SEARCH_PAGE = "true";
  delete process.env.GSC_ROLLOUT_PROJECTS;
  delete process.env.GSC_SYNC_DEV_PROJECTS;
  world = newWorld();
  mocks.world = { current: world };
  installPrisma(world);
  mocks.isModulesEnabled.mockReturnValue(true);
  mocks.primaryGscLink.mockResolvedValue(link());
  mocks.loadPlanInput.mockResolvedValue(loaded());
  mocks.buildCandidates.mockReturnValue({
    candidates: candidatesOf(8),
    filtered: [],
    lowData: false,
    strongPillarClusterIds: [],
  });
  mocks.writeWording.mockResolvedValue({ wording: "AI", items: new Map(), budgetHit: false });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllEnvs();
});

const base = { month: "2026-10", timezone: "Europe/Istanbul", now: NOW, trigger: "manual" as const, userId: "u1" };

describe("createMonthlyPlan", () => {
  it("creates slots, each with an idea, a post and a draft creative and no approval", async () => {
    world.setting = { monthlyCap: 4, autoPlan: true };
    const outcome = await createMonthlyPlan({ link: link(), ...base });
    expect(outcome).toMatchObject({ status: "created", planId: "plan-1", slots: 4 });
    expect(world.row).toMatchObject({ status: "ACTIVE", cap: 4, existingAtPlan: 0, basedOnWeek: "2026-09-28", wording: "AI" });
    const slots = plannedSlotsOf();
    expect(slots.map((slot) => slot.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(world.creatives.size).toBe(4);
    for (const slot of slots) {
      const creative = world.creatives.get(slot.creativeId)!;
      expect(creative).toMatchObject({ status: "DRAFT", planId: null, versions: 0, formatKey: "seo.article" });
      const idea = world.ideas.get(slot.ideaId)!;
      expect(idea.status).toBe("PLANNING");
      expect(idea.concept).toMatchObject({ module: "seo", source: "search" });
      expect(world.posts.get(slot.postId)!.ideaId).toBe(slot.ideaId);
      expect(slot.date.startsWith("2026-10-")).toBe(true);
      expect(slot.reusedIdea).toBe(false);
    }
    // Hiçbir yerde APPROVED yok.
    expect([...world.creatives.values()].some((row) => row.status === "APPROVED")).toBe(false);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_content_plan.created",
        metadata: { month: "2026-10", slots: 4, cap: 4, wording: "AI" },
      }),
    );
  });

  it("spreads slots on distinct weekdays at least two days apart, ascending", async () => {
    await createMonthlyPlan({ link: link(), ...base });
    const dates = plannedSlotsOf().map((slot) => slot.date);
    expect([...dates].sort()).toEqual(dates);
    for (let i = 1; i < dates.length; i += 1) {
      const gap = (Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / 86_400_000;
      expect(gap).toBeGreaterThanOrEqual(2);
    }
    for (const date of dates) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(weekday);
      expect(date > "2026-10-07").toBe(true);
    }
  });

  it("never exceeds max(0, cap - existing) for cap 1..12 and existing 0..16", async () => {
    mocks.buildCandidates.mockReturnValue({
      candidates: candidatesOf(30),
      filtered: [],
      lowData: false,
      strongPillarClusterIds: [],
    });
    for (let cap = 1; cap <= 12; cap += 1) {
      for (let existing = 0; existing <= 16; existing += 4) {
        world = newWorld();
        mocks.world = { current: world };
        installPrisma(world);
        world.setting = { monthlyCap: cap, autoPlan: true };
        world.baseCount = existing;
        mocks.loadPlanInput.mockResolvedValue(loaded({ existingInMonth: existing }));
        const outcome = await createMonthlyPlan({ link: link(), ...base });
        const room = Math.max(0, cap - existing);
        if (outcome.status === "created") {
          expect(outcome.slots).toBeLessThanOrEqual(room);
          expect(world.creatives.size).toBeLessThanOrEqual(room);
          expect(world.baseCount + world.creatives.size).toBeLessThanOrEqual(Math.max(cap, existing));
        } else {
          expect(room === 0 || outcome.status === "empty").toBe(true);
          expect(world.creatives.size).toBe(0);
        }
      }
    }
  });

  it("trims inside the transaction when an article appeared after the first count", async () => {
    world.setting = { monthlyCap: 4, autoPlan: true };
    // Dışarıda 0 sayıldı ama işleme girince 3 makale var.
    world.baseCount = 3;
    mocks.loadPlanInput.mockResolvedValue(loaded({ existingInMonth: 0 }));
    const outcome = await createMonthlyPlan({ link: link(), ...base });
    expect(outcome).toMatchObject({ status: "created", slots: 1 });
    expect(world.creatives.size).toBe(1);
    expect(world.row).toMatchObject({ existingAtPlan: 3 });
  });

  it("writes an EMPTY CAP_FULL row in the transaction when the month filled up meanwhile", async () => {
    world.setting = { monthlyCap: 2, autoPlan: true };
    world.baseCount = 2;
    mocks.loadPlanInput.mockResolvedValue(loaded({ existingInMonth: 0 }));
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "empty", reason: "CAP_FULL" });
    expect(world.row).toMatchObject({ status: "EMPTY" });
    expect(world.creatives.size).toBe(0);
    expect(world.posts.size).toBe(0);
  });

  describe("EMPTY outcomes write an EMPTY row and no pieces", () => {
    const cases: [string, () => void, Date | null, string][] = [
      ["NO_DATA from the input", () => mocks.loadPlanInput.mockResolvedValue({ ok: false, empty: "NO_DATA" }), null, "NO_DATA"],
      [
        "NO_DATA for low data",
        () => mocks.buildCandidates.mockReturnValue({ candidates: [], filtered: [], lowData: true, strongPillarClusterIds: [] }),
        null,
        "NO_DATA",
      ],
      [
        "NO_CLUSTERS without clusters",
        () => mocks.buildCandidates.mockReturnValue({ candidates: [], filtered: [], lowData: false, strongPillarClusterIds: [] }),
        null,
        "NO_CLUSTERS",
      ],
      [
        "NO_GAPS with clusters but no candidates",
        () => {
          mocks.loadPlanInput.mockResolvedValue(loaded({ input: planInputFixture() }));
          mocks.buildCandidates.mockReturnValue({ candidates: [], filtered: [], lowData: false, strongPillarClusterIds: [] });
        },
        null,
        "NO_GAPS",
      ],
      [
        "ALL_FILTERED when every candidate is already covered",
        () => {
          const list = candidatesOf(3);
          mocks.buildCandidates.mockReturnValue({ candidates: list, filtered: [], lowData: false, strongPillarClusterIds: [] });
          mocks.loadPlanInput.mockResolvedValue(
            loaded({
              input: planInputFixture({
                clusters: [],
                existingKeywords: list.map((item) => item.keyword),
              }),
            }),
          );
        },
        null,
        "ALL_FILTERED",
      ],
      ["CAP_FULL", () => mocks.loadPlanInput.mockResolvedValue(loaded({ existingInMonth: 4 })), null, "CAP_FULL"],
      ["NO_ROOM at month end", () => undefined, new Date("2026-10-30T09:00:00Z"), "NO_ROOM"],
    ];
    it.each(cases)("%s", async (_name, arrange, now, reason) => {
      arrange();
      const outcome = await createMonthlyPlan({ link: link(), ...base, now: now ?? NOW });
      expect(outcome).toEqual({ status: "empty", reason });
      expect(world.row).toMatchObject({ status: "EMPTY" });
      expect(parseContentPlanData(world.row!.data).reason).toBe(reason);
      expect(world.creatives.size).toBe(0);
      expect(world.posts.size).toBe(0);
      expect(world.ideas.size).toBe(0);
      expect(world.txRuns).toBe(0);
    });
  });

  it("returns exists for an ACTIVE row and re-evaluates an EMPTY one", async () => {
    world.row = { id: "plan-1", status: "ACTIVE", regenerations: 0, data: planDataFixture() };
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "exists" });
    expect(mocks.loadPlanInput).not.toHaveBeenCalled();

    world.row = {
      id: "plan-1",
      status: "EMPTY",
      regenerations: 0,
      data: planDataFixture({ slots: [], reason: "NO_GAPS", nextSlot: 1 }),
    };
    expect(await createMonthlyPlan({ link: link(), ...base })).toMatchObject({ status: "created" });
    expect(world.row).toMatchObject({ status: "ACTIVE" });
  });

  it("a second call after a created plan reports exists and changes nothing", async () => {
    await createMonthlyPlan({ link: link(), ...base });
    const creatives = world.creatives.size;
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "exists" });
    expect(world.creatives.size).toBe(creatives);
  });

  it("keeps earlier slots and rejected keys when an EMPTY row is planned again", async () => {
    world.row = {
      id: "plan-1",
      status: "EMPTY",
      regenerations: 0,
      data: planDataFixture({
        slots: [slotFixture({ id: "s1", status: "REMOVED" })],
        nextSlot: 2,
        rejected: ["old key"],
        reason: "NO_GAPS",
      }),
    };
    await createMonthlyPlan({ link: link(), ...base });
    const data = dataOf();
    expect(data.rejected).toEqual(["old key"]);
    expect(data.slots.map((slot) => slot.id)).toContain("s1");
    expect(data.slots.find((slot) => slot.id === "s2")).toBeTruthy();
    expect(data.nextSlot).toBe(2 + data.slots.length - 1);
  });

  describe("budget", () => {
    beforeEach(() => {
      mocks.writeWording.mockResolvedValue({ wording: "BASIC", items: new Map(), budgetHit: true });
    });

    it("an automatic plan in the first 5 days writes EMPTY(AI_LIMIT) and asks to retry", async () => {
      const outcome = await createMonthlyPlan({ link: link(), ...base, trigger: "auto", now: EARLY });
      expect(outcome).toEqual({ status: "retry", reason: "BUDGET" });
      expect(world.row).toMatchObject({ status: "EMPTY" });
      expect(parseContentPlanData(world.row!.data).reason).toBe("AI_LIMIT");
      expect(world.creatives.size).toBe(0);
    });

    it("from day 6 on it continues with basic wording and a budget note", async () => {
      const outcome = await createMonthlyPlan({
        link: link(),
        ...base,
        trigger: "auto",
        now: new Date("2026-10-06T09:00:00Z"),
      });
      expect(outcome.status).toBe("created");
      expect(world.row).toMatchObject({ status: "ACTIVE", wording: "BASIC" });
      expect(dataOf().wordingNote).toBe("budget");
      expect(world.creatives.size).toBeGreaterThan(0);
    });

    it("a manual plan in the first days also continues with basic wording", async () => {
      const outcome = await createMonthlyPlan({ link: link(), ...base, trigger: "manual", now: EARLY });
      expect(outcome.status).toBe("created");
      expect(dataOf().wordingNote).toBe("budget");
    });
  });

  it("uses the model's title when valid and falls back to a basic title when it repeats an existing one", async () => {
    const list = candidatesOf(2);
    mocks.buildCandidates.mockReturnValue({ candidates: list, filtered: [], lowData: false, strongPillarClusterIds: [] });
    mocks.loadPlanInput.mockResolvedValue(
      loaded({ input: planInputFixture({ clusters: [], existingTitles: ["Zorbax guide existing page"] }) }),
    );
    mocks.writeWording.mockResolvedValue({
      wording: "AI",
      items: new Map([
        [list[0]!.id, { title: `Everything about ${list[0]!.keyword}`, angle: "angle one", description: "description one" }],
        // Mevcut başlığa çok yakın başlık -> temel başlığa düşer
        [list[1]!.id, { title: `${list[1]!.keyword} extra`, angle: "angle two", description: "description two" }],
      ]),
      budgetHit: false,
    });
    await createMonthlyPlan({ link: link(), ...base });
    const slots = plannedSlotsOf();
    expect(slots[0]!.title).toBe(`Everything about ${list[0]!.keyword}`);
    expect(slots[0]!.angle).toBe("angle one");
    expect(slots[1]!.title.length).toBeGreaterThan(0);
  });

  it("uses the keyword with an upper-case first letter as the basic title and the title as idea text for a non-English project", async () => {
    mocks.loadPlanInput.mockResolvedValue(loaded({ language: "tr" }));
    await createMonthlyPlan({ link: link(), ...base });
    const [slot] = plannedSlotsOf();
    expect(slot!.angle).toBe("");
    expect(slot!.description).toBe("");
    const idea = world.ideas.get(slot!.ideaId)!;
    expect((idea.concept as { draft: { angle: string; description: string; title: string } }).draft).toMatchObject({
      angle: slot!.title,
      description: slot!.title,
    });
  });

  it("is off for a mock link that may not do global work in this process", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.DATABASE_URL = "postgres://user:pw@db.example.com/prod";
    process.env.GSC_SYNC_DEV_PROJECTS = "p1";
    expect(await createMonthlyPlan({ link: link({ isMock: true }), ...base })).toEqual({ status: "off" });
    expect(world.row).toBeNull();
    expect(mocks.loadPlanInput).not.toHaveBeenCalled();
  });

  it("writes isMock plan rows and ideas for a mock link when allowed", async () => {
    await createMonthlyPlan({ link: link({ isMock: true }), ...base });
    expect(world.row).toMatchObject({ isMock: true });
  });

  it("is off when the flag or Modules are off, before any read", async () => {
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "off" });
    process.env.SEO_CONTENT_PLAN = "true";
    mocks.isModulesEnabled.mockReturnValue(false);
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "off" });
    expect(mocks.loadPlanInput).not.toHaveBeenCalled();
  });

  it("retries once on a serialization failure and then succeeds", async () => {
    world.txFailures.push(Object.assign(new Error("conflict"), { code: "P2034" }));
    expect((await createMonthlyPlan({ link: link(), ...base })).status).toBe("created");
    expect(world.txRuns).toBe(2);
  });

  it("reports retry BUSY after two serialization failures", async () => {
    world.txFailures.push(
      Object.assign(new Error("c1"), { code: "P2034" }),
      Object.assign(new Error("c2"), { code: "P2034" }),
    );
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "retry", reason: "BUSY" });
    expect(world.creatives.size).toBe(0);
  });

  it("reports exists when a concurrent writer won the unique race", async () => {
    world.txFailures.push(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "exists" });
  });

  it("asks to retry while the engine is behind and writes no row", async () => {
    mocks.loadPlanInput.mockResolvedValue({ ok: false, retry: "ENGINE_BEHIND" });
    expect(await createMonthlyPlan({ link: link(), ...base })).toEqual({ status: "retry", reason: "ENGINE_BEHIND" });
    expect(world.row).toBeNull();
  });

  describe("pool idea reuse", () => {
    function poolSetup() {
      const list = candidatesOf(1, { reuseIdeaId: "pool-1" });
      mocks.buildCandidates.mockReturnValue({ candidates: list, filtered: [], lowData: false, strongPillarClusterIds: [] });
      mocks.loadPlanInput.mockResolvedValue(
        loaded({
          input: planInputFixture({
            clusters: [],
            poolIdeas: [
              {
                id: "pool-1",
                keyword: list[0]!.keyword,
                title: "The pool idea title",
                angle: "pool angle",
                description: "pool description",
                intent: "informational",
              },
            ],
          }),
        }),
      );
      world.ideas.set("pool-1", {
        id: "pool-1",
        projectId: "p1",
        status: "APPROVED",
        concept: {
          v: 2,
          module: "seo",
          source: "search",
          draft: { keyword: list[0]!.keyword, intent: "informational", title: "The pool idea title", description: "pool description", angle: "pool angle" },
          evidence: [{ title: "Other", url: "https://example.com/x" }],
        },
      });
      return list;
    }

    it("consumes a matching pool idea, keeps its title and records the previous status", async () => {
      poolSetup();
      await createMonthlyPlan({ link: link(), ...base });
      const [slot] = plannedSlotsOf();
      expect(slot).toMatchObject({ ideaId: "pool-1", reusedIdea: true, prevIdeaStatus: "APPROVED", title: "The pool idea title" });
      expect(world.ideas.get("pool-1")!.status).toBe("PLANNING");
      expect(world.ideas.size).toBe(1);
      // Kendi kanıt girdimiz eklendi, eskisi korundu.
      const evidence = (world.ideas.get("pool-1")!.concept as { evidence: { url: string }[] }).evidence;
      expect(evidence).toHaveLength(2);
      expect(evidence[1]!.url).toContain("#content-plan");
      // Havuzdan alınan fikirler için model çağrısı gerekmedi.
      expect(mocks.writeWording.mock.calls[0]![0].candidates).toHaveLength(0);
    });

    it("creates a fresh idea when the pool idea could not be claimed", async () => {
      poolSetup();
      world.poolClaimCount = 0;
      await createMonthlyPlan({ link: link(), ...base });
      const [slot] = plannedSlotsOf();
      expect(slot!.reusedIdea).toBe(false);
      expect(slot!.ideaId).not.toBe("pool-1");
      expect(world.ideas.get("pool-1")!.status).toBe("APPROVED");
    });
  });

  it("records pillars with the weak flag, shares and slot ids, and the relaxed and fewer notes", async () => {
    const list = candidatesOf(3, { clusterId: "c-weak", clusterName: "Weak cluster" });
    mocks.buildCandidates.mockReturnValue({ candidates: list, filtered: [{ candidateId: "x", reason: "LOCAL_INTENT" }], lowData: false, strongPillarClusterIds: [] });
    mocks.loadPlanInput.mockResolvedValue(
      loaded({
        input: planInputFixture({
          clusters: [{ id: "c-weak", name: "Weak cluster", pillarPageId: null, queryIds: [], impressions: 4500, clicks: 0 }],
          nonBrandImpressions: 45_000,
        }),
      }),
    );
    world.setting = { monthlyCap: 4, autoPlan: true };
    await createMonthlyPlan({ link: link(), ...base });
    const data = dataOf();
    expect(data.pillars).toHaveLength(1);
    expect(data.pillars[0]).toMatchObject({ clusterId: "c-weak", weak: true, share: 0.1 });
    expect(data.pillars[0]!.slotIds.length).toBe(data.slots.length);
    expect(data.filtered).toEqual([{ reason: "LOCAL_INTENT", count: 1 }]);
    expect(data.notes.length).toBeGreaterThan(0);
    for (const note of data.notes) expect(note).not.toMatch(/\d/);
    expect(data.totals.nonBrandImpressions).toBe(45_000);
  });
});

describe("skipSlot", () => {
  async function planned() {
    await createMonthlyPlan({ link: link(), ...base });
    return plannedSlotsOf();
  }

  it("archives the piece and the plan-created idea, adds the keyword to rejected and audits", async () => {
    const [first] = await planned();
    const result = await skipSlot({ projectId: "p1", slotId: first!.id, userId: "u1", now: NOW });
    expect(result).toEqual({ ok: true });
    expect(world.creatives.get(first!.creativeId)!.status).toBe("ARCHIVED");
    expect(world.posts.get(first!.postId)!.archivedAt).toBeInstanceOf(Date);
    expect(world.ideas.get(first!.ideaId)!.status).toBe("ARCHIVED");
    const data = dataOf();
    expect(data.slots.find((slot) => slot.id === first!.id)!.status).toBe("SKIPPED");
    expect(data.rejected).toContain(keywordKey(first!.keyword));
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seo_content_plan.slot_skipped", metadata: { kind: first!.kind } }),
    );
    // Atlanan slot ideaId/creativeId/postId'sini korur (forget için).
    expect(data.slots.find((slot) => slot.id === first!.id)).toMatchObject({
      ideaId: first!.ideaId,
      creativeId: first!.creativeId,
      postId: first!.postId,
    });
  });

  it("restores a reused idea to its previous status and strips only our evidence", async () => {
    const list = candidatesOf(1, { reuseIdeaId: "pool-1" });
    mocks.buildCandidates.mockReturnValue({ candidates: list, filtered: [], lowData: false, strongPillarClusterIds: [] });
    mocks.loadPlanInput.mockResolvedValue(
      loaded({
        input: planInputFixture({
          clusters: [],
          poolIdeas: [{ id: "pool-1", keyword: list[0]!.keyword, title: "Pool title", angle: "a", description: "d", intent: "informational" }],
        }),
      }),
    );
    world.ideas.set("pool-1", {
      id: "pool-1",
      projectId: "p1",
      status: "APPROVED",
      concept: {
        v: 2,
        module: "seo",
        source: "search",
        draft: { keyword: list[0]!.keyword, intent: "informational", title: "Pool title", description: "d", angle: "a" },
        evidence: [{ title: "Other", url: "https://example.com/x" }],
      },
    });
    await createMonthlyPlan({ link: link(), ...base });
    const [slot] = plannedSlotsOf();
    expect(await skipSlot({ projectId: "p1", slotId: slot!.id, userId: "u1", now: NOW })).toEqual({ ok: true });
    const idea = world.ideas.get("pool-1")!;
    expect(idea.status).toBe("APPROVED");
    expect((idea.concept as { evidence: { url: string }[] }).evidence).toEqual([
      { title: "Other", url: "https://example.com/x" },
    ]);
  });

  it("refuses a written slot and one with an active card and changes nothing", async () => {
    const [first, second] = await planned();
    world.creatives.get(first!.creativeId)!.versions = 1;
    expect(await skipSlot({ projectId: "p1", slotId: first!.id, userId: "u1", now: NOW })).toEqual({ ok: false, reason: "written" });
    expect(world.creatives.get(first!.creativeId)!.status).toBe("DRAFT");

    world.cards = [
      { workId: "work-1", parsedIntent: { card: { kind: "module-flow", module: "seo", data: { hint: { ideaId: second!.ideaId } } } } },
    ];
    expect(await skipSlot({ projectId: "p1", slotId: second!.id, userId: "u1", now: NOW })).toEqual({ ok: false, reason: "written" });
    expect(world.ideas.get(second!.ideaId)!.status).toBe("PLANNING");
    expect(dataOf().rejected).toEqual([]);
  });

  it("reports not_found for an unknown or already skipped slot and off when the flag is off", async () => {
    const [first] = await planned();
    expect(await skipSlot({ projectId: "p1", slotId: "s99", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "not_found" });
    await skipSlot({ projectId: "p1", slotId: first!.id, userId: "u1", now: NOW });
    expect(await skipSlot({ projectId: "p1", slotId: first!.id, userId: "u1", now: NOW })).toEqual({ ok: false, reason: "not_found" });
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await skipSlot({ projectId: "p1", slotId: "s1", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "off" });
  });
});

describe("moveSlot", () => {
  async function planned() {
    await createMonthlyPlan({ link: link(), ...base });
    return plannedSlotsOf();
  }

  it("moves the post and the creative to 10:00 project time on a later day of the same month", async () => {
    const [first] = await planned();
    const result = await moveSlot({ projectId: "p1", slotId: first!.id, date: "2026-10-28", userId: "u1", now: NOW });
    expect(result).toEqual({ ok: true });
    expect(world.creatives.get(first!.creativeId)!.scheduledFor!.toISOString()).toBe("2026-10-28T07:00:00.000Z");
    expect(world.posts.get(first!.postId)!.scheduledFor!.toISOString()).toBe("2026-10-28T07:00:00.000Z");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ action: "seo_content_plan.slot_moved" }));
  });

  it("refuses the past, today, another month and an invalid date", async () => {
    const [first] = await planned();
    const move = (date: string) => moveSlot({ projectId: "p1", slotId: first!.id, date, userId: "u1", now: NOW });
    expect(await move("2026-10-06")).toEqual({ ok: false, reason: "past" });
    expect(await move("2026-10-07")).toEqual({ ok: false, reason: "past" });
    expect(await move("2026-11-03")).toEqual({ ok: false, reason: "other_month" });
    expect(await move("soon")).toEqual({ ok: false, reason: "past" });
  });

  it("refuses a written slot, a slot with an active card and an unknown slot", async () => {
    const [first, second] = await planned();
    world.creatives.get(first!.creativeId)!.versions = 1;
    expect(await moveSlot({ projectId: "p1", slotId: first!.id, date: "2026-10-28", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "written" });
    world.cards = [
      { workId: null, parsedIntent: { card: { kind: "module-flow", module: "seo", data: { hint: { ideaId: second!.ideaId } } } } },
    ];
    expect(await moveSlot({ projectId: "p1", slotId: second!.id, date: "2026-10-28", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "written" });
    expect(await moveSlot({ projectId: "p1", slotId: "s99", date: "2026-10-28", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("regenerateContentPlan", () => {
  async function planned(cap = 4) {
    world.setting = { monthlyCap: cap, autoPlan: true };
    await createMonthlyPlan({ link: link(), ...base });
    return plannedSlotsOf();
  }

  const regen = (extra: Record<string, unknown> = {}) =>
    regenerateContentPlan({ projectId: "p1", userId: "u1", now: NOW, trigger: "manual", ...extra });

  function freshCandidates() {
    mocks.buildCandidates.mockReturnValue({
      candidates: candidatesOf(8).map((candidate, index) => ({
        ...candidate,
        id: `SUPPORT:n${index}:new ${wordOf(index + 10)}`,
        keyword: `new ${wordOf(index + 10)}`,
        clusterId: `n${index}`,
      })),
      filtered: [],
      lowData: false,
      strongPillarClusterIds: [],
    });
  }

  it("is off without the flag and has no plan without a row", async () => {
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await regen()).toEqual({ ok: false, reason: "off" });
    process.env.SEO_CONTENT_PLAN = "true";
    expect(await regen()).toEqual({ ok: false, reason: "no_plan" });
  });

  it("replaces every untouched slot with new topics, removes the old ones and counts the regeneration", async () => {
    const before = await planned();
    freshCandidates();
    const result = await regen();
    expect(result).toEqual({ ok: true, replaced: 4, kept: 0 });
    const data = dataOf();
    expect(data.slots.filter((slot) => slot.status === "REMOVED")).toHaveLength(4);
    expect(data.slots.filter((slot) => slot.status === "PLANNED")).toHaveLength(4);
    expect(data.regeneratedAt).not.toBeNull();
    expect(world.row).toMatchObject({ regenerations: 1 });
    for (const slot of before) {
      expect(world.creatives.get(slot.creativeId)!.status).toBe("ARCHIVED");
      expect(world.ideas.get(slot.ideaId)!.status).toBe("ARCHIVED");
      // Silinen slotlar forget için kimliklerini korur.
      expect(data.slots.find((item) => item.id === slot.id)).toMatchObject({ creativeId: slot.creativeId, ideaId: slot.ideaId });
    }
    // Sınır asla aşılmaz.
    const live = [...world.creatives.values()].filter((row) => row.status !== "ARCHIVED").length;
    expect(live).toBeLessThanOrEqual(4);
    // Eski anahtar kelimeler 0.5 ile geri çekilir (yeniden hesaplamaya iletilir).
    expect(mocks.buildCandidates.mock.calls.at(-1)![0].deprioritizedKeys.length).toBe(4);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seo_content_plan.regenerated", metadata: { replaced: 4, kept: 0 } }),
    );
  });

  it("keeps a written slot and a slot with an active card", async () => {
    const [written, carded, ...rest] = await planned();
    world.creatives.get(written!.creativeId)!.versions = 1;
    world.cards = [
      { workId: "w", parsedIntent: { card: { kind: "module-flow", module: "seo", data: { hint: { ideaId: carded!.ideaId } } } } },
    ];
    freshCandidates();
    const result = await regen();
    expect(result).toEqual({ ok: true, replaced: rest.length, kept: 2 });
    expect(world.creatives.get(written!.creativeId)!.status).toBe("DRAFT");
    expect(world.creatives.get(carded!.creativeId)!.status).toBe("DRAFT");
    expect(world.ideas.get(carded!.ideaId)!.status).toBe("PLANNING");
    const data = dataOf();
    expect(data.slots.find((slot) => slot.id === written!.id)!.status).toBe("PLANNED");
    expect(data.slots.find((slot) => slot.id === carded!.id)!.status).toBe("PLANNED");
  });

  it("stops after three regenerations", async () => {
    await planned();
    world.row!.regenerations = 3;
    freshCandidates();
    expect(await regen()).toEqual({ ok: false, reason: "limit" });
    expect(world.creatives.size).toBe(4);
    // Tek slot değiştirme sınıra takılmaz.
    const [first] = plannedSlotsOf();
    expect((await regen({ slotId: first!.id })).ok).toBe(true);
    expect(world.row).toMatchObject({ regenerations: 3 });
  });

  it("changes nothing when the engine is behind", async () => {
    const before = await planned();
    mocks.loadPlanInput.mockResolvedValue({ ok: false, retry: "ENGINE_BEHIND" });
    expect(await regen()).toEqual({ ok: false, reason: "behind" });
    for (const slot of before) expect(world.creatives.get(slot.creativeId)!.status).toBe("DRAFT");
    expect(world.row).toMatchObject({ regenerations: 0 });
  });

  it("changes nothing when no new topic can replace the old ones", async () => {
    const before = await planned();
    mocks.buildCandidates.mockReturnValue({ candidates: [], filtered: [], lowData: false, strongPillarClusterIds: [] });
    expect(await regen()).toEqual({ ok: false, reason: "nothing_to_replace" });
    for (const slot of before) expect(world.creatives.get(slot.creativeId)!.status).toBe("DRAFT");
    expect(dataOf().slots.every((slot) => slot.status === "PLANNED")).toBe(true);
  });

  it("replaces one slot: same day, the old keyword excluded, one new slot, no regeneration counted", async () => {
    const [first, ...others] = await planned();
    freshCandidates();
    const result = await regen({ slotId: first!.id });
    expect(result).toEqual({ ok: true, replaced: 1, kept: others.length });
    const data = dataOf();
    const added = data.slots.filter((slot) => !["s1", "s2", "s3", "s4"].includes(slot.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.date).toBe(first!.date);
    expect(data.rejected).toContain(keywordKey(first!.keyword));
    expect(mocks.buildCandidates.mock.calls.at(-1)![0].rejectedKeys).toContain(keywordKey(first!.keyword));
    expect(world.row).toMatchObject({ regenerations: 0 });
  });

  it("refuses to replace a written slot", async () => {
    const [first] = await planned();
    world.creatives.get(first!.creativeId)!.versions = 1;
    freshCandidates();
    expect(await regen({ slotId: first!.id })).toEqual({ ok: false, reason: "nothing_to_replace" });
  });

  it("reports busy after repeated serialization failures and failed on an unexpected error", async () => {
    await planned();
    freshCandidates();
    world.txFailures.push(
      Object.assign(new Error("c1"), { code: "P2034" }),
      Object.assign(new Error("c2"), { code: "P2034" }),
    );
    expect(await regen()).toEqual({ ok: false, reason: "busy" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    world.txFailures.push(new Error("secret query text"));
    expect(await regen()).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret query text");
    spy.mockRestore();
  });
});
