import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// Kart temizliği: Search Console kaynaklı iki alan (plan.quickWins ve
// target.queryCount) silinir, kullanıcının içeriği kalır; tamamlanmış Work'ün
// kartı da temizlenir. Command tablosu bellekte, kart yazıcısı sahte (güncelleme
// fonksiyonu gerçek).

type Row = {
  id: string;
  projectId: string;
  card: ModuleFlowCardData;
  workActive: boolean;
};

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  findManyCalls: [] as unknown[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: {
      findMany: vi.fn(
        async (args: {
          where: { projectId: { in: string[] } };
          take: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          db.findManyCalls.push(args);
          const rows = (db.rows as Row[])
            .filter((row) => args.where.projectId.in.includes(row.projectId))
            .sort((a, b) => a.id.localeCompare(b.id));
          const start = args.cursor
            ? rows.findIndex((row) => row.id === args.cursor?.id) +
              (args.skip ?? 0)
            : 0;
          return rows
            .slice(start, start + args.take)
            .map(({ id, projectId }) => ({ id, projectId }));
        },
      ),
    },
  },
}));

vi.mock("@/server/chat/card-store", () => ({
  updateCommandCard: vi.fn(
    async (input: {
      commandId: string;
      projectId: string;
      requireActiveWork?: boolean;
      update: (card: ModuleFlowCardData) => ModuleFlowCardData | null;
    }) => {
      const row = (db.rows as Row[]).find((r) => r.id === input.commandId);
      if (!row || row.projectId !== input.projectId) {
        return { ok: false, code: "NOT_FOUND", message: "Card not found." };
      }
      // Kullanıcı düzenlemesi değil, silme: etkin Work şartı aranmaz.
      expect(input.requireActiveWork).toBeFalsy();
      const next = input.update(structuredClone(row.card));
      if (next === null) return { ok: true, card: row.card, changed: false };
      row.card = next;
      return { ok: true, card: next, changed: true };
    },
  ),
}));

import { scrubSeoCardsSearchData } from "./forget-cards";

const QUICK_WINS_OK = {
  state: "ok",
  items: [{ query: "blue widgets", impressions: 100, clicks: 3, position: 8.2 }],
};

const PLAN = {
  primaryKeyword: "blue widgets",
  secondaryKeywords: [],
  searchIntent: "commercial",
  intentNote: "",
  titleOptions: ["Blue widgets guide"],
  titleIndex: 0,
  metaDescription: "A guide.",
  outline: [{ h2: "Intro", points: ["a"] }],
  quickWins: QUICK_WINS_OK,
  researchedAt: "2026-10-01T00:00:00.000Z",
};

const TARGET = {
  url: "https://example.com/shoes",
  path: "/shoes",
  title: "Shoes",
  metaDescription: null,
  h1: null,
  h2: [],
  wordCount: 300,
  textHash: null,
  fetchedAt: "2026-10-01T00:00:00.000Z",
  queryCount: 12,
};

// Testlerin okuduğu kart verisi alanları (saklanan JSON).
type CardData = {
  plan: { quickWins: unknown; titleOptions: unknown; outline: unknown };
  target: { queryCount: number; title: string };
  brief: unknown;
  hint: unknown;
};
const dataOf = (item: Row): CardData => item.card.data as unknown as CardData;

function seoCard(data: Record<string, unknown>): ModuleFlowCardData {
  return {
    kind: "module-flow",
    module: "seo",
    title: "SEO Manager",
    step: "plan",
    data,
  };
}

function row(
  id: string,
  data: Record<string, unknown>,
  overrides: Partial<Row> = {},
): Row {
  return {
    id,
    projectId: "p1",
    card: seoCard(data),
    workActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.rows = [];
  db.findManyCalls = [];
});

describe("scrubSeoCardsSearchData", () => {
  it("quick wins'i not-connected yapar, queryCount'u sıfırlar, gerisine dokunmaz", async () => {
    const brief = {
      topic: "Blue widgets",
      siteUrl: "https://example.com",
      language: "en",
      audience: "",
    };
    db.rows = [row("c1", { brief, plan: PLAN, target: TARGET, hint: { ideaId: "i1" } })];

    expect(await scrubSeoCardsSearchData(["p1"])).toBe(1);
    const data = dataOf((db.rows as Row[])[0]!);
    expect(data.plan.quickWins).toEqual({ state: "not-connected" });
    expect(data.target.queryCount).toBe(0);
    // Kullanıcının içeriği ve ilgisiz anahtarlar aynen kalır.
    expect(data.brief).toEqual(brief);
    expect(data.plan.titleOptions).toEqual(PLAN.titleOptions);
    expect(data.plan.outline).toEqual(PLAN.outline);
    expect(data.target.title).toBe("Shoes");
    expect(data.hint).toEqual({ ideaId: "i1" });
  });

  it("aylık plandan gelen hint.keyword ve hint.plannedAt'i siler, konuyu bırakır", async () => {
    db.rows = [
      row("c1", {
        plan: { ...PLAN, quickWins: { state: "not-connected" } },
        target: { ...TARGET, queryCount: 0 },
        hint: {
          ideaId: "i1",
          topic: "Trail guide",
          keyword: "best trail shoes",
          plannedAt: "2026-10-20T09:00:00.000Z",
        },
      }),
    ];
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(1);
    expect(dataOf((db.rows as Row[])[0]!).hint).toEqual({
      ideaId: "i1",
      topic: "Trail guide",
    });
  });

  it("tamamlanmış Work'ün kartını da temizler", async () => {
    db.rows = [row("c1", { plan: PLAN }, { workActive: false })];
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(1);
    expect(dataOf((db.rows as Row[])[0]!).plan.quickWins).toEqual({
      state: "not-connected",
    });
  });

  it("Google verisi olmayan karta dokunmaz", async () => {
    const clean = row("c1", {
      plan: { ...PLAN, quickWins: { state: "not-connected" } },
      target: { ...TARGET, queryCount: 0 },
    });
    const before = structuredClone(clean.card);
    db.rows = [clean];
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(0);
    expect(clean.card).toEqual(before);
  });

  it("yalnız verilen projelerin kartlarını temizler", async () => {
    db.rows = [
      row("c1", { plan: PLAN }),
      row("c2", { plan: PLAN }, { projectId: "p2" }),
    ];
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(1);
    expect(dataOf((db.rows as Row[])[1]!).plan.quickWins).toMatchObject({
      state: "ok",
    });
  });

  it("boş liste sorgu atmaz", async () => {
    expect(await scrubSeoCardsSearchData([])).toBe(0);
    expect(db.findManyCalls).toHaveLength(0);
  });

  it("200'lük sayfalarla gezer", async () => {
    db.rows = Array.from({ length: 450 }, (_, index) =>
      row(`c${String(index).padStart(4, "0")}`, { plan: PLAN }),
    );
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(450);
    expect(db.findManyCalls).toHaveLength(3);
    expect(
      (db.rows as Row[]).every(
        (r) =>
          JSON.stringify(dataOf(r).plan.quickWins) ===
          JSON.stringify({ state: "not-connected" }),
      ),
    ).toBe(true);
  });

  it("bir kartın hatası diğerlerini durdurmaz", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = await import("@/server/chat/card-store");
    vi.mocked(store.updateCommandCard).mockRejectedValueOnce(new Error("busy"));
    db.rows = [row("c1", { plan: PLAN }), row("c2", { plan: PLAN })];
    expect(await scrubSeoCardsSearchData(["p1"])).toBe(1);
    spy.mockRestore();
  });
});
