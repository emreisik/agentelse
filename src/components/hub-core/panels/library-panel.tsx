import { prisma } from "@/lib/prisma";
import { LibraryBrowser, type LibraryAsset } from "./library-browser";
import type { PanelProps } from "./panel-props";

// The "Library" doesn't own any `EntityKind` — it just gathers all Asset
// rows for the project (logos, chat attachments, creative images, documents
// — all in a single table) into one browser. Filtering/view happens on the
// client (LibraryBrowser); since the file count per project is small, it's
// sufficient to fetch the full list in a single query.
export async function LibraryPanel({ projectId }: PanelProps) {
  const assets = await prisma.asset.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      size: true,
      createdAt: true,
      type: true,
    },
  });

  const libraryAssets: LibraryAsset[] = assets.map((asset) => ({
    ...asset,
    createdAt: asset.createdAt.toISOString(),
  }));

  return <LibraryBrowser projectId={projectId} assets={libraryAssets} />;
}
