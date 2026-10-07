import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: boş girdi sorgu atmaz; planın BÜTÜN slotları
// (SKIPPED/REMOVED dahil) taranıp dokunulmamış parçalar kalıcı silinir;
// yazılmış makale kalır; plana ait fikir silinir, yazılmış makaleye bağlı fikir
// yalnız plan kanıtını kaybeder; havuzdan alınmış 'search' fikri silinir,
// başka havuz fikri önceki durumuna döner ve yalnız plan kanıtı çıkar; plan
// satırları silinir; SeoContentSetting bağ silinince kalır, proje silinince
// gider; ikinci çağrı sıfır döner.

const mocks = vi.hoisted(() => ({
  planFindMany: vi.fn(),
  planFindUnique: vi.fn(),
  planDeleteMany: vi.fn(),
  linkFindMany: vi.fn(),
  settingDeleteMany: vi.fn(),
  ideaFindMany: vi.fn(),
  ideaUpdate: vi.fn(),
  ideaDeleteMany: vi.fn(),
  postFindMany: vi.fn(),
  deletePieces: vi.fn(),
  transaction: vi.fn(),
}));

const tx = {
  seoContentPlan: { deleteMany: mocks.planDeleteMany },
  idea: {
    findMany: mocks.ideaFindMany,
    update: mocks.ideaUpdate,
    deleteMany: mocks.ideaDeleteMany,
  },
  post: { findMany: mocks.postFindMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentPlan: {
      findMany: mocks.planFindMany,
      findUnique: mocks.planFindUnique,
    },
    gscSiteLink: { findMany: mocks.linkFindMany },
    seoContentSetting: { deleteMany: mocks.settingDeleteMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("./pieces", () => ({ deleteSlotPiecesInTx: mocks.deletePieces }));

const {
  forgetSeoContentPlanRows,
  forgetSeoContentPlansForCredential,
  forgetSeoContentPlansForLinks,
  forgetSeoContentPlansForProjects,
  rawSlotsOf,
  withoutPlanEvidence,
} = await import("./forget");

const PLAN_URL = "https://app.example.com/projects/p1/arama#content-plan";
const OTHER_URL = "https://example.com/blog/guide";

function slot(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `s${n}`,
    status: "PLANNED",
    creativeId: `cr${n}`,
    postId: `po${n}`,
    ideaId: `idea${n}`,
    reusedIdea: false,
    prevIdeaStatus: null,
    ...extra,
  };
}

const PLAN_ROW = {
  id: "plan-1",
  projectId: "p1",
  data: {
    slots: [
      slot(1),
      slot(2, { status: "SKIPPED" }),
      slot(3, { status: "REMOVED" }),
      slot(4),
      slot(5, { reusedIdea: true, prevIdeaStatus: "RAW" }),
      slot(6, { reusedIdea: true, prevIdeaStatus: "APPROVED" }),
      slot(7, { reusedIdea: true, prevIdeaStatus: "SHORTLISTED" }),
    ],
  },
};

function idea(
  n: number,
  extra: { status?: string; source?: string; evidence?: unknown[] } = {},
) {
  return {
    id: `idea${n}`,
    status: extra.status ?? "PLANNING",
    concept: {
      module: "seo",
      source: extra.source ?? "search",
      evidence: extra.evidence ?? [{ title: "This month's articles", url: PLAN_URL }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  );
  mocks.planFindMany.mockResolvedValue([{ id: "plan-1" }]);
  mocks.planFindUnique.mockResolvedValue(PLAN_ROW);
  mocks.planDeleteMany.mockResolvedValue({ count: 1 });
  mocks.deletePieces.mockImplementation(
    async (_tx: unknown, _project: string, pieces: { creativeId: string }[]) => ({
      // 4. slot yazılmış: silinmez.
      deleted: pieces
        .map((piece) => piece.creativeId)
        .filter((id) => id !== "cr4"),
    }),
  );
  mocks.ideaFindMany.mockResolvedValue([
    idea(1),
    idea(2),
    idea(3),
    idea(4),
    idea(5, { source: "search" }),
    idea(6, { source: "search", status: "PLANNING" }),
    idea(7, { source: "manual" }),
  ]);
  mocks.postFindMany.mockResolvedValue([{ ideaId: "idea4" }]);
  mocks.ideaDeleteMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }),
  );
  mocks.ideaUpdate.mockResolvedValue({});
  mocks.settingDeleteMany.mockResolvedValue({ count: 1 });
  mocks.linkFindMany.mockResolvedValue([{ id: "link-1" }]);
});

describe("forgetSeoContentPlansForLinks", () => {
  it("makes no query for an empty list", async () => {
    expect(await forgetSeoContentPlansForLinks([])).toEqual({
      plans: 0,
      slotsRemoved: 0,
      ideas: 0,
    });
    expect(mocks.planFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("finds the plans by link and hard-deletes untouched pieces of ALL slots", async () => {
    const result = await forgetSeoContentPlansForLinks(["link-1", "link-1"]);
    expect(mocks.planFindMany).toHaveBeenCalledWith({
      where: { linkId: { in: ["link-1"] } },
      select: { id: true },
    });
    const pieces = mocks.deletePieces.mock.calls[0]?.[2] as {
      creativeId: string;
      postId: string;
    }[];
    // SKIPPED ve REMOVED slotlar dahil yedi slotun hepsi.
    expect(pieces.map((piece) => piece.creativeId)).toEqual([
      "cr1",
      "cr2",
      "cr3",
      "cr4",
      "cr5",
      "cr6",
      "cr7",
    ]);
    expect(pieces[0]).toEqual({ creativeId: "cr1", postId: "po1" });
    expect(mocks.deletePieces.mock.calls[0]?.[1]).toBe("p1");
    // Yazılmış makale (cr4) kalır.
    expect(result.slotsRemoved).toBe(6);
    expect(result.plans).toBe(1);
  });

  it("deletes plan-created ideas, keeps the idea with a written article", async () => {
    await forgetSeoContentPlansForLinks(["link-1"]);
    const deleted = (
      mocks.ideaDeleteMany.mock.calls[0]?.[0] as {
        where: { id: { in: string[] }; projectId: string };
      }
    ).where;
    expect(deleted.projectId).toBe("p1");
    // 1, 2, 3 plana ait; 5 ve 6 'search' kaynaklı, 6 APPROVED idi.
    expect(deleted.id.in).toEqual(["idea1", "idea2", "idea3", "idea5"]);
    // Yazılmış makaleye bağlı idea4: silinmez, yalnız plan kanıtı çıkar.
    const updated = mocks.ideaUpdate.mock.calls.map(
      (call) => call[0] as { where: { id: string }; data: Record<string, unknown> },
    );
    const four = updated.find((call) => call.where.id === "idea4");
    expect(four?.data).toEqual({
      concept: expect.objectContaining({ evidence: [] }),
    });
    expect(four?.data).not.toHaveProperty("status");
  });

  it("restores a reused non-search / APPROVED idea and strips only our evidence", async () => {
    mocks.ideaFindMany.mockResolvedValue([
      idea(6, {
        source: "search",
        evidence: [
          { title: "Mine", url: PLAN_URL },
          { title: "Theirs", url: OTHER_URL },
        ],
      }),
      idea(7, { source: "manual" }),
    ]);
    mocks.planFindUnique.mockResolvedValue({
      ...PLAN_ROW,
      data: { slots: [PLAN_ROW.data.slots[5], PLAN_ROW.data.slots[6]] },
    });
    await forgetSeoContentPlansForLinks(["link-1"]);
    expect(mocks.ideaDeleteMany).not.toHaveBeenCalled();
    const calls = mocks.ideaUpdate.mock.calls.map(
      (call) => call[0] as { where: { id: string }; data: Record<string, unknown> },
    );
    const approved = calls.find((call) => call.where.id === "idea6");
    expect(approved?.data).toEqual({
      concept: expect.objectContaining({
        evidence: [{ title: "Theirs", url: OTHER_URL }],
      }),
      status: "APPROVED",
    });
    const manual = calls.find((call) => call.where.id === "idea7");
    expect(manual?.data).toMatchObject({ status: "SHORTLISTED" });
  });

  it("does not touch the status of a reused idea that is no longer PLANNING", async () => {
    mocks.ideaFindMany.mockResolvedValue([
      idea(7, { source: "manual", status: "ACTIVE" }),
    ]);
    mocks.planFindUnique.mockResolvedValue({
      ...PLAN_ROW,
      data: { slots: [PLAN_ROW.data.slots[6]] },
    });
    await forgetSeoContentPlansForLinks(["link-1"]);
    const data = (mocks.ideaUpdate.mock.calls[0]?.[0] as { data: object }).data;
    expect(data).not.toHaveProperty("status");
  });

  it("deletes the plan rows", async () => {
    await forgetSeoContentPlansForLinks(["link-1"]);
    expect(mocks.planDeleteMany).toHaveBeenCalledWith({
      where: { id: "plan-1" },
    });
  });

  it("keeps SeoContentSetting", async () => {
    await forgetSeoContentPlansForLinks(["link-1"]);
    expect(mocks.settingDeleteMany).not.toHaveBeenCalled();
  });

  it("is idempotent: a vanished plan gives zeros and never throws", async () => {
    mocks.planFindUnique.mockResolvedValue(null);
    expect(await forgetSeoContentPlansForLinks(["link-1"])).toEqual({
      plans: 0,
      slotsRemoved: 0,
      ideas: 0,
    });
    mocks.planFindMany.mockResolvedValue([]);
    expect(await forgetSeoContentPlansForLinks(["link-1"])).toEqual({
      plans: 0,
      slotsRemoved: 0,
      ideas: 0,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("scans a slot with a broken shape as long as an id is readable", async () => {
    mocks.planFindUnique.mockResolvedValue({
      id: "plan-1",
      projectId: "p1",
      data: { slots: [{ creativeId: "crX", postId: 5, ideaId: "ideaX" }, null] },
    });
    mocks.ideaFindMany.mockResolvedValue([idea(1)]);
    await forgetSeoContentPlansForLinks(["link-1"]);
    expect(mocks.deletePieces.mock.calls[0]?.[2]).toEqual([
      { creativeId: "crX", postId: "" },
    ]);
  });
});

describe("forgetSeoContentPlansForCredential", () => {
  it("resolves the credential's links first", async () => {
    await forgetSeoContentPlansForCredential("cred-1");
    expect(mocks.linkFindMany).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      select: { id: true },
    });
    expect(mocks.planFindMany).toHaveBeenCalledWith({
      where: { linkId: { in: ["link-1"] } },
      select: { id: true },
    });
    expect(mocks.settingDeleteMany).not.toHaveBeenCalled();
  });
});

describe("forgetSeoContentPlansForProjects", () => {
  it("makes no query for an empty list", async () => {
    expect(await forgetSeoContentPlansForProjects([])).toEqual({
      plans: 0,
      slotsRemoved: 0,
      ideas: 0,
    });
    expect(mocks.planFindMany).not.toHaveBeenCalled();
    expect(mocks.settingDeleteMany).not.toHaveBeenCalled();
  });

  it("forgets the plans of the projects and deletes their settings", async () => {
    const result = await forgetSeoContentPlansForProjects(["p1"]);
    expect(mocks.planFindMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1"] } },
      select: { id: true },
    });
    expect(mocks.settingDeleteMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1"] } },
    });
    expect(result.plans).toBe(1);
  });
});

describe("forgetSeoContentPlanRows", () => {
  it("sums over several plans", async () => {
    const result = await forgetSeoContentPlanRows(["a", "b", "a"]);
    expect(result.plans).toBe(2);
    expect(mocks.planFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("helpers", () => {
  it("rawSlotsOf reads garbage as no slots", () => {
    expect(rawSlotsOf(null)).toEqual([]);
    expect(rawSlotsOf({ slots: "no" })).toEqual([]);
    expect(rawSlotsOf([])).toEqual([]);
  });

  it("withoutPlanEvidence strips only the plan entry and reports no change as null", () => {
    expect(withoutPlanEvidence({ evidence: [{ url: OTHER_URL }] })).toBeNull();
    expect(withoutPlanEvidence(null)).toBeNull();
    expect(withoutPlanEvidence({ evidence: [{ url: "not a url#content-plan" }] }))
      .toEqual({ evidence: [] });
  });
});
