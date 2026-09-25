"use client";

import { useRef, useTransition } from "react";
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
          toast.success("Dosya yüklendi");
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Yükleme başarısız",
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-5 px-5 py-5 text-sm">
      <div>
        <div
          className="text-base font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          İyi işler burada başlar.
        </div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Görseller, ürünler ve markanı anlatan her şey.
        </div>
      </div>

      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className="flex flex-col items-center gap-1 rounded-2xl border border-dashed py-5 text-center transition-colors disabled:opacity-50"
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
          {isPending ? "Yükleniyor…" : "Dosyalarını ekle"}
        </span>
        <span className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
          Görsel, PDF veya metin · 20MB&apos;a kadar
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />

      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <div
            className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase"
            style={{ color: "var(--ws-text-3)" }}
          >
            {group.label}
            <span>{group.assets.length}</span>
          </div>
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
                aria-label={`İndir: ${asset.filename}`}
                className="shrink-0 transition-colors hover:opacity-70"
                style={{ color: "var(--ws-text-3)" }}
              >
                <Download className="size-3.5" />
              </a>
            </div>
          ))}
        </div>
      ))}

      {assets.length === 0 ? (
        <p className="px-1 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Henüz dosya yok — bir logo, katalog veya referans görsel yükle.
        </p>
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
// approximates the spec's exact 3-group split (Marka / Görseller /
// Belgeler) instead of building new upload-time classification for it.
function groupAssets(
  assets: LibraryAsset[],
): { label: string; assets: LibraryAsset[] }[] {
  const brand: LibraryAsset[] = [];
  const images: LibraryAsset[] = [];
  const documents: LibraryAsset[] = [];

  for (const asset of assets) {
    const name = asset.filename.toLowerCase();
    if (name.includes("logo") || name.includes("brand")) {
      brand.push(asset);
    } else if (asset.mimeType.startsWith("image/")) {
      images.push(asset);
    } else {
      documents.push(asset);
    }
  }

  return [
    { label: "Marka", assets: brand },
    { label: "Görseller", assets: images },
    { label: "Belgeler", assets: documents },
  ].filter((group) => group.assets.length > 0);
}
