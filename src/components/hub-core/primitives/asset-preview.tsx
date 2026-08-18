import { FileText } from "lucide-react";

import { ImageLightbox } from "@/components/shared/image-lightbox";

export type AssetSummary = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Image files (mimeType image/*) are shown directly as a thumbnail and
// enlarged in a modal on click; other file types (pdf, txt, csv...) open
// in a new tab via `/api/assets/{id}` as a filename + size badge (a modal
// preview doesn't make sense for these).
export function AssetPreview({ asset }: { asset: AssetSummary | null }) {
  if (!asset) return null;
  const src = `/api/assets/${asset.id}`;
  const isImage = asset.mimeType.startsWith("image/");

  if (isImage) {
    return (
      <ImageLightbox
        src={src}
        alt={asset.filename}
        className="block overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10 transition-opacity hover:opacity-90"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={asset.filename}
          className="max-h-64 w-full object-contain"
        />
      </ImageLightbox>
    );
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg bg-accent/40 px-3 py-2 text-xs transition-colors hover:bg-accent"
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{asset.filename}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {formatBytes(asset.size)}
      </span>
    </a>
  );
}

export function AssetPreviewGrid({ assets }: { assets: AssetSummary[] }) {
  if (assets.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {assets.map((asset) => (
        <AssetPreview key={asset.id} asset={asset} />
      ))}
    </div>
  );
}
