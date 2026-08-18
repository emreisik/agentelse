import "server-only";

import { unlink } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";

// Proje silme. Şemada YALNIZCA Brand tablosu Project'e gerçek bir yabancı
// anahtarla bağlı (onDelete: Cascade); diğer 50 tablodaki `projectId`
// sütunları kısıtlamasız düz sütunlar. Yani `prisma.project.delete()` tek
// başına çağrılırsa veritabanı hiç şikâyet etmeden ~50 tabloda öksüz satır
// bırakır — bu satırlar sonra Sistem Sağlığı, kuyruk ve raporlarda hayalet
// veri olarak görünür.
//
// Bu yüzden silinecek tablo listesi information_schema'dan ÇALIŞMA ANINDA
// türetilir: şemaya yarın `projectId` taşıyan yeni bir tablo eklenirse bu
// servis elle güncellenmeden onu da kapsar.

const LOCAL_ASSET_PREFIX = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

// Kapsam dışı olup kapsam içi bir tabloya SET NULL ile bağlı olan tek
// gerçek artık: silinen işlere ait ölü-kuyruk kayıtları. Bırakılırsa
// Sistem Sağlığı ekranında sahipsiz hata olarak durur.
async function deleteOrphanedDeadLetters(projectId: string): Promise<number> {
  const result = await prisma.deadLetterJob.deleteMany({
    where: { executionJob: { projectId } },
  });
  return result.count;
}

async function projectScopedTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'projectId'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

export type DeletionPreview = {
  projectId: string;
  projectName: string;
  totalRows: number;
  byTable: Array<{ table: string; count: number }>;
  localAssetFiles: number;
};

export const ProjectDeletionService = {
  // Onay diyaloğunda gösterilir: kullanıcı neyi kaybettiğini rakamla görür.
  async preview(projectId: string): Promise<DeletionPreview | null> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    if (!project) return null;

    const tables = await projectScopedTables();
    const byTable: Array<{ table: string; count: number }> = [];
    let totalRows = 0;

    for (const table of tables) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "${table}" WHERE "projectId" = $1`,
        projectId,
      );
      const count = Number(rows[0]?.count ?? 0);
      totalRows += count;
      if (count > 0) byTable.push({ table, count });
    }

    const assets = await prisma.asset.count({
      where: { projectId, storageKey: { startsWith: LOCAL_ASSET_PREFIX } },
    });

    return {
      projectId: project.id,
      projectName: project.name,
      totalRows,
      byTable: byTable.sort((a, b) => b.count - a.count),
      localAssetFiles: assets,
    };
  },

  // Tüm proje verisini tek işlemde siler. Kısmi silme mümkün değil: ya
  // hepsi gider ya hiçbiri.
  async delete(projectId: string): Promise<{
    deletedRows: number;
    deletedFiles: number;
    projectName: string;
  }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    if (!project) throw new Error("Proje bulunamadı");

    // Dosya adlarını işlemden ÖNCE topla; satırlar silindikten sonra
    // hangi dosyaların bu projeye ait olduğunu bilmenin yolu kalmaz.
    const localAssets = await prisma.asset.findMany({
      where: { projectId, storageKey: { startsWith: LOCAL_ASSET_PREFIX } },
      select: { storageKey: true },
    });

    const tables = await projectScopedTables();
    let deletedRows = await deleteOrphanedDeadLetters(projectId);

    deletedRows += await prisma.$transaction(
      async (tx) => {
        let count = 0;
        for (const table of tables) {
          count += await tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "projectId" = $1`,
            projectId,
          );
        }
        count += await tx.$executeRawUnsafe(
          `DELETE FROM "Project" WHERE "id" = $1`,
          projectId,
        );
        return count;
      },
      { timeout: 30_000 },
    );

    // Dosya silme işlemin DIŞINDA ve en sonda: dosya sistemi geri
    // alınamaz, veritabanı işlemi geri alınabilir. Sıra tersine olsaydı
    // başarısız bir işlem dosyaları çoktan yok etmiş olurdu.
    let deletedFiles = 0;
    for (const asset of localAssets) {
      const filename = asset.storageKey.slice(LOCAL_ASSET_PREFIX.length);
      // Yol kaçışına karşı: yalnızca düz dosya adı kabul edilir.
      if (!filename || filename.includes("/") || filename.includes("..")) {
        continue;
      }
      try {
        await unlink(path.join(LOCAL_ASSETS_DIR, filename));
        deletedFiles += 1;
      } catch {
        // Dosya zaten yok veya erişilemiyor — silme başarısı buna bağlı değil.
      }
    }

    return { deletedRows, deletedFiles, projectName: project.name };
  },
};
