import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  workGet: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  transaction: vi.fn(),
  txCreativeFindFirst: vi.fn(),
  txCommandFindFirst: vi.fn(),
  txVersionCreate: vi.fn(),
  txCreativeUpdateMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { get: mocks.workGet },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

import { updateSlotTextAction } from "@/server/actions/slot-text-actions";

const PROJECT = "p1";
const WORK = "w1";
const SLOT = "c1";

function creative(over: Record<string, unknown> = {}) {
  return {
    id: SLOT,
    status: "IN_REVIEW",
    planId: "plan1",
    versions: [
      {
        version: 2,
        assetId: "asset-1",
        caption: "Old caption",
        copy: "On-image words",
        contentFormat: "FEED_PORTRAIT",
        generationProvider: "openai",
        generationMetadata: { alternatives: ["a2"] },
      },
    ],
    ...over,
  };
}

const planRow = {
  parsedIntent: {
    card: { kind: "content-plan-draft", savedCreativeIds: [SLOT, "c2"] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws1",
    defaultBrandId: "b1",
  });
  mocks.workGet.mockResolvedValue({ id: WORK, status: "ACTIVE" });
  mocks.txCreativeFindFirst.mockResolvedValue(creative());
  mocks.txCommandFindFirst.mockResolvedValue(planRow);
  mocks.txVersionCreate.mockResolvedValue({ id: "v3" });
  mocks.txCreativeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        creative: {
          findFirst: mocks.txCreativeFindFirst,
          updateMany: mocks.txCreativeUpdateMany,
        },
        command: { findFirst: mocks.txCommandFindFirst },
        creativeVersion: { create: mocks.txVersionCreate },
      }),
  );
});

describe("updateSlotTextAction", () => {
  it("writes the new words as the next version and keeps the picture and the rest", async () => {
    const result = await updateSlotTextAction(
      PROJECT,
      WORK,
      SLOT,
      "  New caption\r\n\r\n\r\nSecond line ",
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.txVersionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.txVersionCreate.mock.calls[0]![0].data).toMatchObject({
      creativeId: SLOT,
      version: 3,
      assetId: "asset-1",
      // A picture post keeps its words in the caption; the copy is untouched.
      caption: "New caption\n\nSecond line",
      copy: "On-image words",
      contentFormat: "FEED_PORTRAIT",
      generationProvider: "openai",
      generationMetadata: { alternatives: ["a2"] },
      revisionReason: "Edited by you",
    });
    expect(mocks.txCreativeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: SLOT,
        projectId: PROJECT,
        status: { in: ["DRAFT", "IN_REVIEW"] },
      },
      data: { currentVersionId: "v3" },
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
  });

  it("a written piece (no picture) changes its copy, not its caption", async () => {
    mocks.txCreativeFindFirst.mockResolvedValue(
      creative({
        versions: [
          {
            version: 1,
            assetId: null,
            caption: null,
            copy: "A script",
            contentFormat: null,
            generationProvider: "plan-run",
            generationMetadata: null,
          },
        ],
      }),
    );
    const result = await updateSlotTextAction(PROJECT, WORK, SLOT, "A better script");
    expect(result).toEqual({ ok: true });
    expect(mocks.txVersionCreate.mock.calls[0]![0].data).toMatchObject({
      version: 2,
      copy: "A better script",
      caption: null,
    });
  });

  it("refuses an empty or oversized text before any write", async () => {
    for (const text of ["   ", "x".repeat(3001)]) {
      const result = await updateSlotTextAction(PROJECT, WORK, SLOT, text);
      expect(result).toMatchObject({ ok: false, code: "EMPTY" });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses once the piece is approved", async () => {
    mocks.txCreativeFindFirst.mockResolvedValue(creative({ status: "APPROVED" }));
    const result = await updateSlotTextAction(PROJECT, WORK, SLOT, "Late edit");
    expect(result).toMatchObject({ ok: false, code: "LOCKED" });
    expect(mocks.txVersionCreate).not.toHaveBeenCalled();
  });

  it("rolls back when a decision lands between the read and the write", async () => {
    mocks.txCreativeUpdateMany.mockResolvedValue({ count: 0 });
    const result = await updateSlotTextAction(PROJECT, WORK, SLOT, "Race");
    expect(result).toMatchObject({ ok: false, code: "LOCKED" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("only a slot of a plan of this Work can be edited", async () => {
    mocks.txCommandFindFirst.mockResolvedValue(null);
    expect(await updateSlotTextAction(PROJECT, WORK, SLOT, "x")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    mocks.txCommandFindFirst.mockResolvedValue({
      parsedIntent: {
        card: { kind: "content-plan-draft", savedCreativeIds: ["other"] },
      },
    });
    expect(await updateSlotTextAction(PROJECT, WORK, SLOT, "x")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    // The plan Command is looked up with the project and the Work.
    expect(mocks.txCommandFindFirst.mock.calls[0]![0].where).toEqual({
      id: "plan1",
      projectId: PROJECT,
      workId: WORK,
    });
  });

  it("a completed Work and a missing Work refuse", async () => {
    mocks.workGet.mockResolvedValueOnce({ id: WORK, status: "COMPLETED" });
    expect(await updateSlotTextAction(PROJECT, WORK, SLOT, "x")).toMatchObject({
      ok: false,
      code: "WORK",
    });
    mocks.workGet.mockResolvedValueOnce(null);
    expect(await updateSlotTextAction(PROJECT, WORK, SLOT, "x")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("is off when Works is off and bad ids are invalid", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    expect(await updateSlotTextAction(PROJECT, WORK, SLOT, "x")).toMatchObject({
      ok: false,
      code: "DISABLED",
    });
    mocks.isWorksEnabled.mockReturnValue(true);
    expect(await updateSlotTextAction(PROJECT, "", SLOT, "x")).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });
});
