import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  workOwnershipOf: vi.fn(),
  creativeFindUnique: vi.fn(),
  creativeFindFirst: vi.fn(),
  creativeUpdateMany: vi.fn(),
  workFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  commandFindMany: vi.fn(),
  transaction: vi.fn(),
  appendVersionTx: vi.fn(),
  updateCommandCard: vi.fn(),
  record: vi.fn(),
  revalidatePath: vi.fn(),
  approvalCreate: vi.fn(),
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
vi.mock("@/server/works/work-owned", () => ({
  workOwnershipOf: mocks.workOwnershipOf,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: mocks.creativeFindUnique },
    asset: { findFirst: mocks.assetFindFirst },
    command: { findMany: mocks.commandFindMany },
    approval: { create: mocks.approvalCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { appendVersionTx: mocks.appendVersionTx },
}));
vi.mock("@/server/chat/card-store", () => ({
  updateCommandCard: mocks.updateCommandCard,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));

import { adoptCreativeVariantAction } from "@/server/actions/creative-variant-actions";

const tx = {
  creative: {
    findFirst: mocks.creativeFindFirst,
    updateMany: mocks.creativeUpdateMany,
  },
  work: { findFirst: mocks.workFindFirst },
};

function creativeRow(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    projectId: "p1",
    workspaceId: "w1",
    status: "IN_REVIEW",
    currentVersionId: "v2",
    versions: [
      {
        id: "v2",
        version: 2,
        assetId: "a2",
        caption: "cap",
        copy: "copy",
        contentFormat: "POST",
        generationProvider: "openai",
        generationMetadata: null,
      },
      {
        id: "v1",
        version: 1,
        assetId: "a1",
        caption: "cap",
        copy: "copy",
        contentFormat: "POST",
        generationProvider: "openai",
        generationMetadata: {
          alternatives: [{ assetId: "alt1" }, { assetId: "alt2" }],
        },
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    defaultBrandId: "b1",
  });
  mocks.workOwnershipOf.mockResolvedValue({ owned: true, workId: "work1" });
  mocks.workFindFirst.mockResolvedValue({ status: "ACTIVE" });
  mocks.creativeFindUnique.mockResolvedValue({ projectId: "p1" });
  mocks.creativeFindFirst.mockResolvedValue(creativeRow());
  mocks.creativeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.appendVersionTx.mockResolvedValue({ id: "v3", version: 3 });
  mocks.assetFindFirst.mockResolvedValue({ width: 1080, height: 1350 });
  mocks.commandFindMany.mockResolvedValue([{ id: "cmd1" }]);
  mocks.updateCommandCard.mockResolvedValue({ ok: true });
  mocks.transaction.mockImplementation((fn: (t: typeof tx) => unknown) =>
    fn(tx),
  );
});

describe("adoptCreativeVariantAction (W97)", () => {
  it("appends a new version from a stored alternative, patches the card, audits, no approval", async () => {
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toEqual({ ok: true, versionNumber: 3 });
    expect(mocks.transaction.mock.calls[0]![1]).toMatchObject({
      isolationLevel: "Serializable",
    });
    expect(mocks.appendVersionTx).toHaveBeenCalledWith(
      tx,
      "c1",
      "p1",
      expect.objectContaining({
        assetId: "alt1",
        caption: "cap",
        revisionReason: "Picked another picture",
        generationMetadata: {
          source: "variant-swap",
          fromVersion: 2,
          assetId: "alt1",
        },
      }),
    );
    const patch = mocks.updateCommandCard.mock.calls[0]![0];
    expect(patch.expectKinds).toEqual(["creative-ready"]);
    expect(patch.update({ kind: "creative-ready", title: "t" })).toMatchObject({
      assetId: "alt1",
      versionNumber: 3,
      assetWidth: 1080,
      assetHeight: 1350,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "creative.variant_adopted",
        entityId: "c1",
      }),
    );
    expect(mocks.approvalCreate).not.toHaveBeenCalled();
  });

  it("keeps every picture once on the card: the displaced picture takes the adopted one's place", async () => {
    // Card as the materialize step wrote it: current a2, alternatives alt1+alt2.
    await adoptCreativeVariantAction("c1", "alt1");
    const patch = mocks.updateCommandCard.mock.calls[0]![0];
    const out = patch.update({
      kind: "creative-ready",
      title: "t",
      assetId: "a2",
      assetWidth: 1080,
      assetHeight: 1350,
      alternatives: [{ assetId: "alt1" }, { assetId: "alt2" }],
    }) as { assetId: string; alternatives: { assetId: string }[] };
    expect(out.assetId).toBe("alt1");
    expect(out.alternatives.map((a) => a.assetId)).toEqual(["a2", "alt2"]);
    expect(out.alternatives[0]).toMatchObject({
      assetId: "a2",
      assetWidth: 1080,
      assetHeight: 1350,
    });
  });

  it("accepts an asset of an existing version", async () => {
    const res = await adoptCreativeVariantAction("c1", "a1");
    expect(res.ok).toBe(true);
    expect(mocks.appendVersionTx).toHaveBeenCalled();
  });

  it("is LOCKED once approved and appends nothing", async () => {
    mocks.creativeFindFirst.mockResolvedValue(
      creativeRow({ status: "APPROVED" }),
    );
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toMatchObject({ ok: false, code: "LOCKED" });
    expect(mocks.creativeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
  });

  it("is LOCKED for a DRAFT without a version", async () => {
    mocks.creativeFindFirst.mockResolvedValue(
      creativeRow({ status: "DRAFT", versions: [], currentVersionId: null }),
    );
    expect(await adoptCreativeVariantAction("c1", "alt1")).toMatchObject({
      ok: false,
      code: "LOCKED",
    });
  });

  it("refuses an asset that is not an alternative or a version asset", async () => {
    const res = await adoptCreativeVariantAction("c1", "foreign");
    expect(res).toMatchObject({ ok: false, code: "FOREIGN_ASSET" });
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
  });

  it("is idempotent when the asset already is the latest", async () => {
    const res = await adoptCreativeVariantAction("c1", "a2");
    expect(res).toEqual({ ok: true, alreadyCurrent: true, versionNumber: 2 });
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("runs the compare-and-set before appending", async () => {
    await adoptCreativeVariantAction("c1", "alt1");
    expect(mocks.creativeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "c1",
        projectId: "p1",
        status: { in: ["IN_REVIEW", "DRAFT"] },
        currentVersionId: "v2",
      },
      data: { currentVersionId: "v2" },
    });
    expect(mocks.creativeUpdateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.appendVersionTx.mock.invocationCallOrder[0]!,
    );
  });

  it("appends nothing when the compare-and-set matches no row", async () => {
    mocks.creativeUpdateMany.mockResolvedValue({ count: 0 });
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
    expect(mocks.updateCommandCard).not.toHaveBeenCalled();
  });

  it.each(["P2002", "P2034"])("maps %s to CONFLICT", async (code) => {
    mocks.appendVersionTx.mockRejectedValue(
      Object.assign(new Error("x"), { code }),
    );
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "Already updated.",
    });
  });

  it("checks access on the creative's own project", async () => {
    mocks.creativeFindUnique.mockResolvedValue({ projectId: "p9" });
    mocks.requireProjectAccess.mockRejectedValue(new Error("forbidden"));
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p9");
    expect(res).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses when the Work is done", async () => {
    mocks.workFindFirst.mockResolvedValue({ status: "COMPLETED" });
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toMatchObject({ ok: false, code: "WORK" });
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
  });

  it("does nothing when Works is off", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.creativeFindUnique).not.toHaveBeenCalled();
  });

  it("answers RATE and writes nothing past the rate limit", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const res = await adoptCreativeVariantAction("c1", "alt1");
    expect(res).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "variant-adopt:u1",
      30,
      expect.any(Number),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.appendVersionTx).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before touching the database", async () => {
    const res = await adoptCreativeVariantAction("", "alt1");
    expect(res).toMatchObject({ ok: false, code: "INVALID" });
    expect(mocks.creativeFindUnique).not.toHaveBeenCalled();
  });
});
