import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// liveSlotCount (countLiveSlots / removeUnlessLive): bayrak kapalıyken sorgu
// bugünküyle aynıdır; SEO_ACTIONS açıkken SEO Manager kartının takvimdeki
// makalesi (Creative.planId = kartın Command'ı) Work'ü CANLI yapar. Prisma
// sahte: sorgunun şekli ve sayımın akışı sınanır, anlamı entegrasyon testinde.

type Where = Record<string, unknown>;

const db = vi.hoisted(() => ({
  commands: [] as { id: string; card: Record<string, unknown> }[],
  creatives: [] as { planId: string; status: string }[],
  commandWhere: [] as Where[],
}));

// Sahte Command.findMany: where'i yürüyerek kartın uyup uymadığına bakar.
function matches(where: Where, card: Record<string, unknown>): boolean {
  const own = (part: Where) => {
    // cardKind is the generated copy of card.kind (migration
    // 20261007110000); other card fields are still matched by JSON path.
    if (typeof part.cardKind === "string" && card.kind !== part.cardKind) {
      return false;
    }
    const intent = part.parsedIntent as
      { path: string[]; equals: string } | undefined;
    if (!intent) return true;
    const key = intent.path[1] as string;
    return card[key] === intent.equals;
  };
  if (Array.isArray(where.OR)) {
    return (where.OR as Where[]).some((part) => matches(part, card));
  }
  if (Array.isArray(where.AND)) {
    return (where.AND as Where[]).every((part) => matches(part, card));
  }
  return own(where);
}

vi.mock("@/lib/prisma", () => {
  const client = {
    command: {
      findMany: async ({ where }: { where: Where }) => {
        db.commandWhere.push(where);
        return db.commands
          .filter((row) => matches(where, row.card))
          .map((row) => ({ id: row.id }));
      },
    },
    creative: {
      count: async ({
        where,
      }: {
        where: { planId: { in: string[] }; status: { notIn: string[] } };
      }) =>
        db.creatives.filter(
          (row) =>
            where.planId.in.includes(row.planId) &&
            !where.status.notIn.includes(row.status),
        ).length,
    },
  };
  return { prisma: client };
});
vi.mock("@/server/guided-setup/store", () => ({
  isUniqueViolation: () => false,
}));

const { WorkRepository } = await import("./work.repository");

const original = process.env.SEO_ACTIONS;

beforeEach(() => {
  db.commands = [
    { id: "plan1", card: { kind: "content-plan-draft" } },
    { id: "seo1", card: { kind: "module-flow", module: "seo" } },
    { id: "ads1", card: { kind: "module-flow", module: "ads" } },
  ];
  db.creatives = [];
  db.commandWhere = [];
});

afterEach(() => {
  if (original === undefined) delete process.env.SEO_ACTIONS;
  else process.env.SEO_ACTIONS = original;
});

describe("liveSlotCount: SEO kartlarının makaleleri", () => {
  it("bayrak kapalıyken yalnız plan kartlarına bakar (bugünkü sorgu)", async () => {
    delete process.env.SEO_ACTIONS;
    db.creatives = [{ planId: "seo1", status: "APPROVED" }];

    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(0);
    expect(db.commandWhere[0]).toEqual({
      projectId: "p1",
      workId: "w1",
      cardKind: "content-plan-draft",
    });
  });

  it("bayrak açıkken SEO kartının takvimdeki makalesi Work'ü canlı yapar", async () => {
    process.env.SEO_ACTIONS = "true";
    db.creatives = [{ planId: "seo1", status: "APPROVED" }];

    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(1);
  });

  it("bayrak açıkken de yayımlanmış ya da arşivlenmiş makale sayılmaz", async () => {
    process.env.SEO_ACTIONS = "true";
    db.creatives = [
      { planId: "seo1", status: "PUBLISHED" },
      { planId: "seo1", status: "ARCHIVED" },
    ];

    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(0);
  });

  it("başka modülün kartı sayılmaz", async () => {
    process.env.SEO_ACTIONS = "true";
    db.creatives = [{ planId: "ads1", status: "APPROVED" }];

    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(0);
  });

  it("plan kartının slotu iki durumda da sayılır", async () => {
    db.creatives = [{ planId: "plan1", status: "SCHEDULED" }];
    delete process.env.SEO_ACTIONS;
    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(1);
    process.env.SEO_ACTIONS = "true";
    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(1);
  });
});
