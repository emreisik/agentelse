import { beforeEach, describe, expect, it, vi } from "vitest";

// The two critical guarantees of deletion:
//   1. The table list comes from information_schema — a hand-written list
//      is not trusted, otherwise new tables would silently end up orphaned.
//   2. File deletion happens only after the database transaction finishes
//      SUCCESSFULLY. In the reverse order, a failed transaction would have
//      already destroyed the files.

const deleteAsset = vi.hoisted(() => vi.fn());
vi.mock("@/server/storage/asset-storage", () => ({ deleteAsset }));

const prismaMock = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  asset: { findMany: vi.fn(), count: vi.fn() },
  deadLetterJob: { deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { ProjectDeletionService } =
  await import("@/server/projects/project-deletion.service");

const executed: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  executed.length = 0;

  prismaMock.project.findUnique.mockResolvedValue({ name: "Biduniq" });
  prismaMock.deadLetterJob.deleteMany.mockResolvedValue({ count: 2 });
  prismaMock.$queryRaw.mockResolvedValue([
    { table_name: "Task" },
    { table_name: "Signal" },
  ]);
  prismaMock.asset.findMany.mockResolvedValue([
    { storageKey: "local-asset://abc.png" },
  ]);
  deleteAsset.mockResolvedValue(true);
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<number>) =>
      fn({
        $executeRawUnsafe: async (sql: string) => {
          executed.push(sql);
          return 5;
        },
      }),
  );
});

describe("ProjectDeletionService.delete", () => {
  it("deletes every table from information_schema, plus Project", async () => {
    await ProjectDeletionService.delete("p-1");

    expect(executed).toEqual([
      'DELETE FROM "Task" WHERE "projectId" = $1',
      'DELETE FROM "Signal" WHERE "projectId" = $1',
      'DELETE FROM "Project" WHERE "id" = $1',
    ]);
  });

  it("reports the deleted row count including dead letters", async () => {
    const result = await ProjectDeletionService.delete("p-1");
    // 2 dead letters + 3 statements x 5 rows
    expect(result.deletedRows).toBe(17);
    expect(result.projectName).toBe("Biduniq");
  });

  it("deletes asset files only AFTER the transaction succeeds", async () => {
    const result = await ProjectDeletionService.delete("p-1");

    expect(deleteAsset).toHaveBeenCalledTimes(1);
    expect(deleteAsset).toHaveBeenCalledWith("local-asset://abc.png");
    expect(result.deletedFiles).toBe(1);
  });

  it("also deletes r2:// assets, not just local-asset:// ones", async () => {
    prismaMock.asset.findMany.mockResolvedValue([
      { storageKey: "local-asset://abc.png" },
      { storageKey: "r2://def.png" },
    ]);

    const result = await ProjectDeletionService.delete("p-1");

    expect(deleteAsset).toHaveBeenCalledTimes(2);
    expect(deleteAsset).toHaveBeenCalledWith("r2://def.png");
    expect(result.deletedFiles).toBe(2);
  });

  it("does not touch any file if the transaction fails", async () => {
    prismaMock.$transaction.mockRejectedValue(new Error("deadlock"));

    await expect(ProjectDeletionService.delete("p-1")).rejects.toThrow(
      "deadlock",
    );
    expect(deleteAsset).not.toHaveBeenCalled();
  });

  it("does not count deletion as failed toward deletedFiles if the backend reports failure", async () => {
    deleteAsset.mockResolvedValue(false);

    const result = await ProjectDeletionService.delete("p-1");

    expect(result.deletedFiles).toBe(0);
    expect(result.projectName).toBe("Biduniq");
  });

  it("throws if the project does not exist", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);

    await expect(ProjectDeletionService.delete("missing")).rejects.toThrow(
      "Project not found",
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
