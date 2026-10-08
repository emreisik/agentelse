import { prisma } from "@/lib/prisma";
import { MediaLibrary, type MediaItem } from "@/components/brand/media-library";

const LIMIT = 300;

// The Media tab: the brand's own photos and what the library understood of them.
export async function MediaSection({ projectId }: { projectId: string }) {
  const rows = await prisma.brandMedia.findMany({
    where: { projectId, kind: "IMAGE" },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: {
      id: true,
      assetId: true,
      status: true,
      description: true,
      tags: true,
      orientation: true,
      hasPeople: true,
      quality: true,
      useCount: true,
      archivedAt: true,
    },
  });
  const items: MediaItem[] = rows.map((row) => ({
    id: row.id,
    assetId: row.assetId,
    status: row.status,
    description: row.description,
    tags: row.tags,
    orientation: row.orientation,
    hasPeople: row.hasPeople,
    quality: row.quality,
    useCount: row.useCount,
    archived: row.archivedAt !== null,
  }));
  return <MediaLibrary projectId={projectId} items={items} />;
}
