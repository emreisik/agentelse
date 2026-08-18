import { prisma } from "@/lib/prisma";
import { LibraryBrowser, type LibraryAsset } from "./library-browser";
import type { PanelProps } from "./panel-props";

// "Kütüphane" hiçbir `EntityKind`'in sahibi değil, sadece proje genelindeki
// tüm Asset satırlarını (logo, sohbet eki, creative görseli, belge — hepsi
// tek tabloda) tek bir gözatıcıda toplar. Filtreleme/görünüm client'ta
// (LibraryBrowser) yapılır; proje başına dosya sayısı küçük olduğundan
// tam listeyi tek sorguda çekmek yeterli.
export async function KutuphanePanel({ projectId }: PanelProps) {
  const assets = await prisma.asset.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      size: true,
      createdAt: true,
    },
  });

  const libraryAssets: LibraryAsset[] = assets.map((asset) => ({
    ...asset,
    createdAt: asset.createdAt.toISOString(),
  }));

  return <LibraryBrowser projectId={projectId} assets={libraryAssets} />;
}
