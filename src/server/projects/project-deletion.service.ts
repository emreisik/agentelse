import "server-only";

import { prisma } from "@/lib/prisma";
import { deleteAsset } from "@/server/storage/asset-storage";

// Project deletion. In the schema, ONLY the Brand table is linked to
// Project with a real foreign key (onDelete: Cascade); the `projectId`
// columns on the other ~50 tables are plain, unconstrained columns. That
// means if `prisma.project.delete()` is called on its own, the database
// leaves orphaned rows in ~50 tables without complaint — these rows then
// show up as ghost data in System Health, queues and reports.
//
// That's why the list of tables to delete from is derived from
// information_schema AT RUNTIME: if a new table carrying `projectId` is
// added to the schema tomorrow, this service covers it too without a
// manual update.

// The one real leftover that's out-of-scope but linked to an in-scope
// table via SET NULL: dead-letter records belonging to deleted jobs. If
// left behind, they sit as ownerless errors on the System Health screen.
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
  // Shown in the confirmation dialog: the user sees exactly what they're about to lose, in numbers.
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

    const assets = await prisma.asset.count({ where: { projectId } });

    return {
      projectId: project.id,
      projectName: project.name,
      totalRows,
      byTable: byTable.sort((a, b) => b.count - a.count),
      localAssetFiles: assets,
    };
  },

  // Deletes all project data in a single transaction. Partial deletion is
  // not possible: either everything goes, or nothing does.
  async delete(projectId: string): Promise<{
    deletedRows: number;
    deletedFiles: number;
    projectName: string;
  }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    if (!project) throw new Error("Project not found");

    // Collect storageKeys BEFORE the transaction; once the rows are
    // deleted, there's no way left to know which files belonged to this
    // project.
    const projectAssets = await prisma.asset.findMany({
      where: { projectId },
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

    // File deletion happens OUTSIDE the transaction and last: storage
    // (disk or R2) can't be rolled back, but the database transaction can.
    // If the order were reversed, a failed transaction would have already
    // destroyed the files. deleteAsset() is a safe no-op for storageKeys
    // it doesn't recognize (e.g. mock:// placeholders with no real file).
    let deletedFiles = 0;
    for (const asset of projectAssets) {
      if (await deleteAsset(asset.storageKey)) deletedFiles += 1;
    }

    return { deletedRows, deletedFiles, projectName: project.name };
  },
};
