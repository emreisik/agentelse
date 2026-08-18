import { beforeEach, describe, expect, it, vi } from "vitest";

// Silmenin iki kritik güvencesi:
//   1. Tablo listesi information_schema'dan gelir — elle yazılmış bir
//      listeye güvenilmez, yoksa yeni tablolar sessizce öksüz kalır.
//   2. Dosya silme, veritabanı işlemi BAŞARIYLA bittikten sonra yapılır.
//      Ters sırada başarısız bir işlem dosyaları çoktan yok etmiş olurdu.

const unlink = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ unlink }));

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
  it("information_schema'dan gelen her tabloyu ve Project'i siler", async () => {
    await ProjectDeletionService.delete("p-1");

    expect(executed).toEqual([
      'DELETE FROM "Task" WHERE "projectId" = $1',
      'DELETE FROM "Signal" WHERE "projectId" = $1',
      'DELETE FROM "Project" WHERE "id" = $1',
    ]);
  });

  it("silinen satır sayısını ölü kuyruk dahil raporlar", async () => {
    const result = await ProjectDeletionService.delete("p-1");
    // 2 ölü kuyruk + 3 ifade × 5 satır
    expect(result.deletedRows).toBe(17);
    expect(result.projectName).toBe("Biduniq");
  });

  it("yerel varlık dosyalarını işlem başarılı olduktan SONRA siler", async () => {
    const result = await ProjectDeletionService.delete("p-1");

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(String(unlink.mock.calls[0]?.[0])).toContain("abc.png");
    expect(result.deletedFiles).toBe(1);
  });

  it("işlem düşerse hiçbir dosyaya dokunmaz", async () => {
    prismaMock.$transaction.mockRejectedValue(new Error("deadlock"));

    await expect(ProjectDeletionService.delete("p-1")).rejects.toThrow(
      "deadlock",
    );
    expect(unlink).not.toHaveBeenCalled();
  });

  it("yol kaçışı içeren storageKey'i dosya sisteminde işleme almaz", async () => {
    prismaMock.asset.findMany.mockResolvedValue([
      { storageKey: "local-asset://../../../etc/passwd" },
      { storageKey: "local-asset://nested/path.png" },
    ]);

    const result = await ProjectDeletionService.delete("p-1");

    expect(unlink).not.toHaveBeenCalled();
    expect(result.deletedFiles).toBe(0);
  });

  it("dosya silinemezse silme işlemini başarısız saymaz", async () => {
    unlink.mockRejectedValue(new Error("ENOENT"));

    const result = await ProjectDeletionService.delete("p-1");

    expect(result.deletedFiles).toBe(0);
    expect(result.projectName).toBe("Biduniq");
  });

  it("proje yoksa hata verir", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);

    await expect(ProjectDeletionService.delete("yok")).rejects.toThrow(
      "Proje bulunamadı",
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
