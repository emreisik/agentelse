import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yalnız önceki aylardaki dokunulmamış (DRAFT,
// sürümsüz, planId'siz, ay başından önce) slotlar süpürülür; yazılmış ve kartla
// bağlanmış parçalar kalır; havuzdan alınmış fikir önceki durumuna döner,
// plana ait fikir ARCHIVED olur; slot REMOVED işaretlenir ve anahtar kelime
// rejected'a eklenmez; arşivlenemeyen parça süpürülmez; idempotenttir.

const mocks = vi.hoisted(() => ({
  planFindMany: vi.fn(),
  planUpdate: vi.fn(),
  creativeFindMany: vi.fn(),
  ideaUpdateMany: vi.fn(),
  archive: vi.fn(),
  transaction: vi.fn(),
}));

const tx = {
  seoContentPlan: { update: mocks.planUpdate },
  idea: { updateMany: mocks.ideaUpdateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentPlan: { findMany: mocks.planFindMany },
    creative: { findMany: mocks.creativeFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("./pieces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pieces")>()),
  archiveSlotPiecesInTx: mocks.archive,
}));

const { sweepStaleSlots } = await import("./sweep");

const NOW = new Date("2026-11-03T09:00:00.000Z");
const INPUT = {
  linkId: "link-1",
  projectId: "p1",
  currentMonth: "2026-11",
  timezone: "UTC",
  now: NOW,
};

function slot(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "PLANNED",
    creativeId: `cr-${id}`,
    postId: `po-${id}`,
    ideaId: `idea-${id}`,
    reusedIdea: false,
    prevIdeaStatus: null,
    ...extra,
  };
}

function untouched(id: string, scheduledFor = "2026-10-20T10:00:00.000Z") {
  return {
    id: `cr-${id}`,
    status: "DRAFT",
    planId: null,
    scheduledFor: new Date(scheduledFor),
    versions: [],
  };
}

const PLAN = {
  id: "plan-oct",
  data: {
    v: 1,
    nextSlot: 6,
    rejected: ["already skipped"],
    slots: [
      slot("s1"),
      slot("s2", { reusedIdea: true, prevIdeaStatus: "APPROVED" }),
      slot("s3"),
      slot("s4"),
      slot("s5", { status: "SKIPPED" }),
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  );
  mocks.planFindMany.mockResolvedValue([PLAN]);
  mocks.creativeFindMany.mockResolvedValue([
    untouched("s1"),
    untouched("s2"),
    // yazılmış: sürümü var
    { ...untouched("s3"), versions: [{ id: "v1" }] },
    // kartla bağlanmış: planId dolu
    { ...untouched("s4"), planId: "cmd-1" },
  ]);
  mocks.archive.mockImplementation(
    async (
      _tx: unknown,
      _project: string,
      pieces: { creativeId: string }[],
    ) => ({ archived: pieces.map((piece) => piece.creativeId) }),
  );
  mocks.ideaUpdateMany.mockResolvedValue({ count: 1 });
  mocks.planUpdate.mockResolvedValue({});
});

describe("sweepStaleSlots", () => {
  it("queries only earlier ACTIVE plans of the link", async () => {
    await sweepStaleSlots(INPUT);
    expect(mocks.planFindMany).toHaveBeenCalledWith({
      where: {
        linkId: "link-1",
        projectId: "p1",
        status: "ACTIVE",
        month: { lt: "2026-11" },
      },
      select: { id: true, data: true },
    });
  });

  it("does nothing without earlier plans", async () => {
    mocks.planFindMany.mockResolvedValue([]);
    expect(await sweepStaleSlots(INPUT)).toEqual({ swept: 0 });
    expect(mocks.creativeFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("sweeps only untouched past-month slots; written and card-linked stay", async () => {
    const result = await sweepStaleSlots(INPUT);
    expect(result).toEqual({ swept: 2 });
    expect(mocks.archive).toHaveBeenCalledTimes(1);
    expect(mocks.archive.mock.calls[0]?.[2]).toEqual([
      { creativeId: "cr-s1", postId: "po-s1" },
      { creativeId: "cr-s2", postId: "po-s2" },
    ]);
    expect(mocks.archive.mock.calls[0]?.[3]).toBe(NOW);
  });

  it("leaves a slot already moved into the current month alone", async () => {
    mocks.creativeFindMany.mockResolvedValue([
      untouched("s1", "2026-11-10T10:00:00.000Z"),
    ]);
    mocks.planFindMany.mockResolvedValue([
      { id: "p", data: { slots: [slot("s1")] } },
    ]);
    expect(await sweepStaleSlots(INPUT)).toEqual({ swept: 0 });
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("restores a reused idea to prevIdeaStatus and archives a plan-created one", async () => {
    await sweepStaleSlots(INPUT);
    expect(mocks.ideaUpdateMany).toHaveBeenCalledWith({
      where: { id: "idea-s1", projectId: "p1", status: "PLANNING" },
      data: { status: "ARCHIVED" },
    });
    expect(mocks.ideaUpdateMany).toHaveBeenCalledWith({
      where: { id: "idea-s2", projectId: "p1", status: "PLANNING" },
      data: { status: "APPROVED" },
    });
    // Yazılmış ve kartla bağlanmış slotların fikirlerine dokunulmaz.
    expect(mocks.ideaUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("marks swept slots REMOVED, keeps their ids and does not touch rejected", async () => {
    await sweepStaleSlots(INPUT);
    const written = mocks.planUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { data: { slots: Record<string, unknown>[]; rejected: string[] } };
    };
    expect(written.where).toEqual({ id: "plan-oct" });
    const slots = written.data.data.slots;
    expect(slots.map((item) => item.status)).toEqual([
      "REMOVED",
      "REMOVED",
      "PLANNED",
      "PLANNED",
      "SKIPPED",
    ]);
    // forget için kimlikler durur.
    expect(slots[0]).toMatchObject({
      creativeId: "cr-s1",
      postId: "po-s1",
      ideaId: "idea-s1",
    });
    expect(written.data.data.rejected).toEqual(["already skipped"]);
  });

  it("does not remove a slot whose piece could not be archived (touched meanwhile)", async () => {
    mocks.archive.mockResolvedValue({ archived: ["cr-s1"] });
    expect(await sweepStaleSlots(INPUT)).toEqual({ swept: 1 });
    const slots = (
      mocks.planUpdate.mock.calls[0]?.[0] as {
        data: { data: { slots: { status: string }[] } };
      }
    ).data.data.slots;
    expect(slots[0]?.status).toBe("REMOVED");
    expect(slots[1]?.status).toBe("PLANNED");
  });

  it("removes a slot whose piece is gone or already archived and frees its idea", async () => {
    mocks.creativeFindMany.mockResolvedValue([
      { ...untouched("s1"), status: "ARCHIVED" },
    ]);
    mocks.planFindMany.mockResolvedValue([
      { id: "p", data: { slots: [slot("s1"), slot("s2")] } },
    ]);
    expect(await sweepStaleSlots(INPUT)).toEqual({ swept: 2 });
    // Zaten arşivli ya da yok: arşivlenecek parça yok, ama fikirler serbest.
    expect(mocks.ideaUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("is idempotent: REMOVED slots are not looked at again", async () => {
    mocks.planFindMany.mockResolvedValue([
      {
        id: "plan-oct",
        data: {
          slots: [slot("s1", { status: "REMOVED" }), slot("s2", { status: "SKIPPED" })],
        },
      },
    ]);
    expect(await sweepStaleSlots(INPUT)).toEqual({ swept: 0 });
    expect(mocks.creativeFindMany).not.toHaveBeenCalled();
    expect(mocks.planUpdate).not.toHaveBeenCalled();
  });

  it("does not archive a reused idea whose previous status is unknown", async () => {
    mocks.planFindMany.mockResolvedValue([
      {
        id: "p",
        data: { slots: [slot("s1", { reusedIdea: true, prevIdeaStatus: "???" })] },
      },
    ]);
    await sweepStaleSlots(INPUT);
    expect(mocks.ideaUpdateMany).not.toHaveBeenCalled();
  });
});
