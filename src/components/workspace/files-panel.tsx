"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Download,
  File,
  FileText,
  Image as ImageIcon,
  Video,
} from "lucide-react";

import { uploadLibraryAssetAction } from "@/server/actions/library-actions";
import type { LibraryAsset } from "@/components/hub-core/panels/library-browser";
import { assetUrl } from "@/lib/asset-url";

// Brand Workspace right panel's Files tab — a compact grouped list,
// deliberately a SEPARATE component from LibraryBrowser (which stays
// exactly as-is: it's also the full Library page reached from the Advanced
// menu, a real file manager with search/grid/list views that this redesign
// must not touch). Reuses the same asset data and the same upload action,
// just a much smaller presentation.
export function FilesPanel({
  projectId,
  assets,
}: {
  projectId: string;
  assets: LibraryAsset[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = groupAssets(assets);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("file", file);

    startTransition(async () => {
      try {
        const result = await uploadLibraryAssetAction(formData);
        if (result.ok) {
          toast.success("File uploaded");
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4 text-sm">
      <div>
        <div
          className="text-base font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Good work starts here.
        </div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Images, products, and everything that tells your brand&apos;s story.
        </div>
      </div>

      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className="flex flex-col items-center gap-1 rounded-2xl border border-dashed py-4 text-center transition-colors disabled:opacity-50"
        style={{ borderColor: "var(--ws-olive)" }}
      >
        <span
          className="flex size-8 items-center justify-center rounded-full"
          style={{
            background: "var(--ws-surface-2)",
            color: "var(--ws-text-2)",
          }}
        >
          <Download className="size-4 -scale-y-100" />
        </span>
        <span
          className="mt-1.5 text-xs font-medium"
          style={{ color: "var(--ws-text-2)" }}
        >
          {isPending ? "Uploading…" : "Add your files"}
        </span>
        <span className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
          Image, PDF or text · up to 20MB
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />

      {groups.map((group) =>
        group.kind === "images" ? (
          <ImageGroup key={group.label} label={group.label} assets={group.assets} />
        ) : (
          <div key={group.label} className="flex flex-col gap-0.5">
            <GroupLabel label={group.label} count={group.assets.length} />
            {group.assets.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--ws-hover)]"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: "var(--ws-surface-2)" }}
                >
                  <FileTypeIcon
                    mimeType={asset.mimeType}
                    className="size-3.5"
                    style={{ color: "var(--ws-text-2)" }}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-xs font-medium"
                    style={{ color: "var(--ws-text-body)" }}
                  >
                    {asset.filename}
                  </div>
                  <div
                    className="text-[9px] uppercase"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    {extensionLabel(asset.mimeType)}
                  </div>
                </div>
                <a
                  href={`/api/assets/${asset.id}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Download ${asset.filename}`}
                  className="shrink-0 transition-colors hover:opacity-70"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  <Download className="size-3.5" />
                </a>
              </div>
            ))}
          </div>
        ),
      )}

      {assets.length === 0 ? (
        <p className="px-1 text-xs" style={{ color: "var(--ws-text-3)" }}>
          No files yet — upload a logo, catalogue or reference image.
        </p>
      ) : null}
    </div>
  );
}

function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <div
      className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase"
      style={{ color: "var(--ws-text-3)" }}
    >
      {label}
      <span>{count}</span>
    </div>
  );
}

// How many thumbnails a group shows before "Show all": a project collects
// every generated image here, and each tile loads the full file.
export const IMAGE_PREVIEW_LIMIT = 9;

// Images are recognised by sight, not by file name: a grid of thumbnails, each
// opening the full image in a new tab. Logos are shown whole (contain), photos
// fill their tile (cover).
function ImageGroup({
  label,
  assets,
}: {
  label: string;
  assets: LibraryAsset[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? assets : assets.slice(0, IMAGE_PREVIEW_LIMIT);
  const isBrand = label === "Brand";
  return (
    <div className="flex flex-col">
      <GroupLabel label={label} count={assets.length} />
      <ul className="grid grid-cols-3 gap-1.5">
        {shown.map((asset) => (
          <li key={asset.id}>
            <a
              href={`/api/assets/${asset.id}`}
              target="_blank"
              rel="noreferrer"
              title={asset.filename}
              data-file-thumb={asset.id}
              className="block aspect-square overflow-hidden rounded-lg border transition-opacity hover:opacity-85"
              style={{
                borderColor: "var(--ws-border)",
                background: "var(--ws-surface-2)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it */}
              <img
                src={assetUrl(asset.id, "thumb")}
                alt={asset.filename}
                loading="lazy"
                decoding="async"
                className={
                  isBrand ? "size-full object-contain p-2" : "size-full object-cover"
                }
              />
            </a>
          </li>
        ))}
      </ul>
      {assets.length > IMAGE_PREVIEW_LIMIT ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 self-start px-1 text-[11px] font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--ws-text-2)" }}
        >
          {expanded ? "Show less" : `Show all ${assets.length}`}
        </button>
      ) : null}
    </div>
  );
}

function extensionLabel(mimeType: string): string {
  return mimeType.split("/")[1]?.replace("quicktime", "mov") ?? "file";
}

function FileTypeIcon({
  mimeType,
  className,
  style,
}: {
  mimeType: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (mimeType.startsWith("image/"))
    return <ImageIcon className={className} style={style} />;
  if (mimeType.startsWith("video/"))
    return <Video className={className} style={style} />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) {
    return <FileText className={className} style={style} />;
  }
  return <File className={className} style={style} />;
}

// Best-effort semantic grouping from what's already on the Asset record
// (mime type + filename) — there's no dedicated "category" field on Asset
// yet (see docs/brand-workspace-migration.md §7 Phase 9 audit), so this
// approximates the spec's exact 3-group split (Brand / Images / Documents)
// instead of building new upload-time classification for it.
export function groupAssets(
  assets: LibraryAsset[],
): { label: string; kind: "images" | "list"; assets: LibraryAsset[] }[] {
  const brand: LibraryAsset[] = [];
  const images: LibraryAsset[] = [];
  const documents: LibraryAsset[] = [];

  for (const asset of assets) {
    const name = asset.filename.toLowerCase();
    const isImage = asset.mimeType.startsWith("image/");
    if (isImage && (name.includes("logo") || name.includes("brand"))) {
      brand.push(asset);
    } else if (isImage) {
      images.push(asset);
    } else {
      documents.push(asset);
    }
  }

  return (
    [
      { label: "Brand", kind: "images", assets: brand },
      { label: "Images", kind: "images", assets: images },
      { label: "Documents", kind: "list", assets: documents },
    ] as const
  )
    .filter((group) => group.assets.length > 0)
    .map((group) => ({ ...group, assets: [...group.assets] }));
}
