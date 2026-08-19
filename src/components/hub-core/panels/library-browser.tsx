"use client";

import {
  Fragment,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  File,
  FileSpreadsheet,
  FileText,
  Grid3x3,
  Library,
  List,
  Loader2,
  Search,
  Send,
  SlidersHorizontal,
  Upload,
  Video,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { smartDate } from "@/lib/dates";
import { uploadLibraryAssetAction } from "@/server/actions/library-actions";
import { createCreativeFromLibraryAssetAction } from "@/server/actions/creative-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ImageLightbox } from "@/components/shared/image-lightbox";

export type LibraryAsset = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  type: string;
};

type TabKey = "all" | "images" | "videos" | "documents";
type ViewMode = "list" | "grid";

const ACCEPTED_FILE_TYPES =
  "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,text/markdown,video/mp4,video/quicktime,video/webm";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImageAsset(asset: LibraryAsset): boolean {
  return asset.mimeType.startsWith("image/");
}

// TikTok's publish flow specifically requires a VIDEO-typed Asset (see
// publishCreativeToSocialCore in publish-creative.ts) — this is the only
// upload path that can produce one (see library-actions.ts).
function isVideoAsset(asset: LibraryAsset): boolean {
  return asset.type === "VIDEO";
}

function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  if (mimeType.startsWith("video/")) return <Video className={className} />;
  if (mimeType === "text/csv") return <FileSpreadsheet className={className} />;
  if (
    mimeType === "application/pdf" ||
    mimeType === "text/plain" ||
    mimeType === "text/markdown"
  ) {
    return <FileText className={className} />;
  }
  return <File className={className} />;
}

// Images enlarge in a lightbox on click (see the same pattern in
// asset-preview.tsx); other file types open in a new tab via /api/assets/{id}.
function LibraryEntryLink({
  asset,
  className,
  children,
}: {
  asset: LibraryAsset;
  className?: string;
  children: ReactNode;
}) {
  const src = `/api/assets/${asset.id}`;
  if (isImageAsset(asset)) {
    return (
      <ImageLightbox src={src} alt={asset.filename} className={className}>
        {children}
      </ImageLightbox>
    );
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}

function FileThumb({
  asset,
  size,
}: {
  asset: LibraryAsset;
  size: "sm" | "lg";
}) {
  const isImage = isImageAsset(asset);
  const dimClass = size === "sm" ? "size-8" : "aspect-square w-full";

  if (isImage) {
    return (
      <div
        className={cn(
          "shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-foreground/10",
          dimClass,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
        <img
          src={`/api/assets/${asset.id}`}
          alt={asset.filename}
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-foreground/10",
        dimClass,
      )}
    >
      <FileTypeIcon
        mimeType={asset.mimeType}
        className={size === "sm" ? "size-4" : "size-7"}
      />
    </div>
  );
}

function TabPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({
  hasAnyAssets,
  onUploadClick,
}: {
  hasAnyAssets: boolean;
  onUploadClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Library className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium">
          {hasAnyAssets ? "No results found" : "No files yet"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {hasAnyAssets
            ? "Try a different search or tab."
            : "Images and documents belonging to this project will be listed here."}
        </p>
      </div>
      {!hasAnyAssets ? (
        <Button size="sm" onClick={onUploadClick}>
          <Upload className="size-4" />
          Upload File
        </Button>
      ) : null}
    </div>
  );
}

// Inline caption form for turning a video Asset into a publishable TikTok
// Creative (see createCreativeFromLibraryAssetAction) — kept as a real
// top-level component (not an inline closure) so its <textarea> doesn't
// remount and lose focus/value on every LibraryBrowser re-render.
function PrepareForTikTokForm({
  caption,
  onCaptionChange,
  onSubmit,
  onCancel,
  pending,
}: {
  caption: string;
  onCaptionChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5">
      <Input
        value={caption}
        onChange={(event) => onCaptionChange(event.target.value)}
        placeholder="Caption for this TikTok video…"
        className="h-8 flex-1 text-xs"
        autoFocus
      />
      <Button
        size="sm"
        className="h-8 shrink-0 gap-1"
        disabled={pending}
        onClick={onSubmit}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        Create
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 shrink-0"
        disabled={pending}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </div>
  );
}

// File explorer as seen in the screenshot: search + "New" (actual upload) +
// All/Images/Videos/Documents tabs + grid/list toggle. All filtering happens
// client-side — the file count per project is small, no need for a server round-trip.
export function LibraryBrowser({
  projectId,
  assets,
}: {
  projectId: string;
  assets: LibraryAsset[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabKey>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which video asset currently has its inline "prepare for TikTok" caption
  // form open — at most one at a time, keyed by assetId.
  const [preparingAssetId, setPreparingAssetId] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [preparePending, startPrepareTransition] = useTransition();

  const imageCount = useMemo(
    () => assets.filter(isImageAsset).length,
    [assets],
  );
  const videoCount = useMemo(
    () => assets.filter(isVideoAsset).length,
    [assets],
  );
  const documentCount = assets.length - imageCount - videoCount;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (tab === "images" && !isImageAsset(asset)) return false;
      if (tab === "videos" && !isVideoAsset(asset)) return false;
      if (tab === "documents" && (isImageAsset(asset) || isVideoAsset(asset)))
        return false;
      if (q && !asset.filename.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, tab, query]);

  function triggerUpload() {
    fileInputRef.current?.click();
  }

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

  function openPrepareForm(assetId: string) {
    setPreparingAssetId(assetId);
    setCaption("");
  }

  function submitPrepareForTikTok(assetId: string) {
    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("assetId", assetId);
    formData.set("platform", "TIKTOK");
    formData.set("caption", caption);

    startPrepareTransition(async () => {
      try {
        const result = await createCreativeFromLibraryAssetAction(formData);
        if (result.ok) {
          toast.success("Ready to publish — find it on the project page.");
          setPreparingAssetId(null);
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not prepare video",
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="rounded-full pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                disabled={pending}
                className="ml-auto shrink-0 gap-1 rounded-full"
              />
            }
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            New
            <ChevronDown className="size-3.5 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={triggerUpload}>
              <Upload className="size-4 text-muted-foreground" />
              Upload File
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-1">
        <TabPill active={tab === "all"} onClick={() => setTab("all")}>
          All
          <span className="text-xs text-muted-foreground">{assets.length}</span>
        </TabPill>
        <TabPill active={tab === "images"} onClick={() => setTab("images")}>
          Images
          <span className="text-xs text-muted-foreground">{imageCount}</span>
        </TabPill>
        <TabPill active={tab === "videos"} onClick={() => setTab("videos")}>
          Videos
          <span className="text-xs text-muted-foreground">{videoCount}</span>
        </TabPill>
        <TabPill
          active={tab === "documents"}
          onClick={() => setTab("documents")}
        >
          Documents
          <span className="text-xs text-muted-foreground">{documentCount}</span>
        </TabPill>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
          >
            <SlidersHorizontal className="size-4" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => setViewMode("grid")}
            className={viewMode !== "grid" ? "text-muted-foreground" : ""}
          >
            <Grid3x3 className="size-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => setViewMode("list")}
            className={viewMode !== "list" ? "text-muted-foreground" : ""}
          >
            <List className="size-4" />
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          hasAnyAssets={assets.length > 0}
          onUploadClick={triggerUpload}
        />
      ) : viewMode === "list" ? (
        <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="w-32">Modified</TableHead>
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((asset) => (
                <Fragment key={asset.id}>
                  <TableRow>
                    <TableCell className="max-w-0">
                      <LibraryEntryLink
                        asset={asset}
                        className="flex min-w-0 items-center gap-3"
                      >
                        <FileThumb asset={asset} size="sm" />
                        <span className="min-w-0 flex-1 truncate">
                          {asset.filename}
                        </span>
                      </LibraryEntryLink>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {smartDate(asset.createdAt)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatBytes(asset.size)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isVideoAsset(asset) ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Prepare for TikTok"
                          className="text-muted-foreground"
                          onClick={() => openPrepareForm(asset.id)}
                        >
                          <Send className="size-3.5" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  {preparingAssetId === asset.id ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-2">
                        <PrepareForTikTokForm
                          caption={caption}
                          onCaptionChange={setCaption}
                          onSubmit={() => submitPrepareForTikTok(asset.id)}
                          onCancel={() => setPreparingAssetId(null)}
                          pending={preparePending}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map((asset) => (
            <div
              key={asset.id}
              className="overflow-hidden rounded-xl ring-1 ring-foreground/10 transition-colors hover:ring-primary/30"
            >
              <LibraryEntryLink asset={asset} className="block">
                <FileThumb asset={asset} size="lg" />
                <div className="space-y-0.5 p-2.5">
                  <p className="truncate text-xs font-medium">
                    {asset.filename}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(asset.size)}
                  </p>
                </div>
              </LibraryEntryLink>
              {isVideoAsset(asset) ? (
                <div className="border-t border-border p-2.5">
                  {preparingAssetId === asset.id ? (
                    <PrepareForTikTokForm
                      caption={caption}
                      onCaptionChange={setCaption}
                      onSubmit={() => submitPrepareForTikTok(asset.id)}
                      onCancel={() => setPreparingAssetId(null)}
                      pending={preparePending}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full gap-1 text-xs"
                      onClick={() => openPrepareForm(asset.id)}
                    >
                      <Send className="size-3.5" />
                      Prepare for TikTok
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
