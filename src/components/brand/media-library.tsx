"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Check,
  Loader2,
  Pencil,
  SquarePen,
  RotateCw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { assetUrl } from "@/lib/asset-url";
import { foldForMatch } from "@/lib/text-fold";
import { cn } from "@/lib/utils";
import {
  archiveBrandMediaAction,
  deleteBrandMediaAction,
  makePhotoPostAction,
  reanalyzeBrandMediaAction,
  updateBrandMediaTagsAction,
  uploadBrandPhotoAction,
} from "@/server/actions/brand-media-actions";

export type MediaItem = {
  id: string;
  assetId: string;
  status: "PENDING" | "OK" | "FAILED" | "SKIPPED";
  description: string | null;
  tags: string[];
  orientation: string | null;
  hasPeople: boolean;
  quality: number | null;
  useCount: number;
  archived: boolean;
};

type Filter = "all" | "ready" | "waiting" | "attention" | "archived";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "waiting", label: "Analyzing" },
  { key: "attention", label: "Needs attention" },
  { key: "archived", label: "Archived" },
];

function matches(item: MediaItem, filter: Filter): boolean {
  if (filter === "archived") return item.archived;
  if (item.archived) return false;
  if (filter === "ready") return item.status === "OK";
  if (filter === "waiting") return item.status === "PENDING";
  if (filter === "attention") return item.status === "FAILED";
  return true;
}

type Upload = { name: string; state: "queued" | "sending" | "done" | "failed"; note?: string };

// The brand's own photos: add them, see what the library understood of each,
// fix the tags, archive or delete. Ideas and posts find and use them from here
// (docs/brand-media.md).
export function MediaLibrary({
  projectId,
  items,
}: {
  projectId: string;
  items: MediaItem[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [consent, setConsent] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [editing, setEditing] = useState<MediaItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Photos are read a few seconds after they land: refresh until they are.
  const waiting = items.some((item) => item.status === "PENDING" && !item.archived);
  useEffect(() => {
    if (!waiting) return undefined;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      router.refresh();
      if (ticks >= 40) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, router]);

  const shown = useMemo(() => {
    const needle = foldForMatch(query.trim());
    return items.filter((item) => {
      if (!matches(item, filter)) return false;
      if (!needle) return true;
      const haystack = foldForMatch(
        [item.description ?? "", ...item.tags].join(" "),
      );
      return needle.split(/\s+/).every((word) => haystack.includes(word));
    });
  }, [items, filter, query]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map(({ key }) => [key, items.filter((i) => matches(i, key)).length]),
      ) as Record<Filter, number>,
    [items],
  );

  async function send(files: File[]) {
    if (!consent) {
      toast.error("Confirm the photo rights first.");
      return;
    }
    const images = files.filter((file) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name));
    if (images.length === 0) {
      toast.error("Choose photos (JPG, PNG or WebP).");
      return;
    }
    setUploads(images.map((file) => ({ name: file.name, state: "queued" })));
    for (const [index, file] of images.entries()) {
      const mark = (patch: Partial<Upload>) =>
        setUploads((list) =>
          list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
        );
      mark({ state: "sending" });
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("consent", "yes");
      form.set("file", file);
      try {
        const result = await uploadBrandPhotoAction(form);
        mark(
          result.ok
            ? { state: "done", note: result.duplicate ? "Already in the library" : undefined }
            : { state: "failed", note: result.message },
        );
      } catch {
        mark({ state: "failed", note: "Upload failed" });
      }
    }
    router.refresh();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="font-heading text-lg font-semibold tracking-tight">Media</h2>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Your own photos. Each one is read once, so ideas can find the right
          picture and posts can use it as it is, with your logo, headline and
          design on top.
        </p>
      </header>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void send(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "rounded-2xl border border-dashed p-5 transition-colors",
          dragging ? "border-foreground/50 bg-accent/50" : "border-border bg-card",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent">
              <Upload className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">Add photos</p>
              <p className="text-xs text-muted-foreground">
                Drop them here or choose files. JPG, PNG or WebP, up to 25 MB
                each. Location data is removed.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => input.current?.click()}
            disabled={!consent}
          >
            Choose photos
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            hidden
            onChange={(event) => {
              void send(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            I have the right to use these photos, and the permission of the
            people shown in them. Each photo is sent once to our AI provider to
            be described; we do not use it to train models.
          </span>
        </label>
        {uploads.length > 0 ? (
          <ul className="mt-4 space-y-1 text-xs">
            {uploads.map((entry, index) => (
              <li key={`${entry.name}-${index}`} className="flex items-center gap-2">
                {entry.state === "sending" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : entry.state === "done" ? (
                  <Check className="size-3 text-success" />
                ) : entry.state === "failed" ? (
                  <span className="size-3 text-destructive">!</span>
                ) : (
                  <span className="size-3 rounded-full ring-1 ring-foreground/20" />
                )}
                <span className="truncate">{entry.name}</span>
                {entry.note ? (
                  <span className="text-muted-foreground">{entry.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ring-1 transition-colors",
                filter === key
                  ? "bg-foreground text-background ring-foreground"
                  : "ring-foreground/15 hover:bg-accent",
              )}
            >
              {label}
              <span className="tabular-nums opacity-70">{counts[key]}</span>
            </button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by what is in the photo"
          className="h-8 max-w-60"
        />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {items.length === 0
            ? "No photos yet. Add the real photos of your place, product and team."
            : "Nothing matches."}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((item) => (
            <MediaCard
              key={item.id}
              projectId={projectId}
              item={item}
              onEdit={() => setEditing(item)}
            />
          ))}
        </div>
      )}

      {editing ? (
        <EditDialog
          projectId={projectId}
          item={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function MediaCard({
  projectId,
  item,
  onEdit,
}: {
  projectId: string;
  item: MediaItem;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(job: () => Promise<{ ok: boolean; message?: string }>, done: string) {
    startTransition(async () => {
      const result = await job();
      if (result.ok) {
        toast.success(done);
        router.refresh();
      } else {
        toast.error(result.message ?? "Something went wrong");
      }
    });
  }

  const status =
    item.status === "OK"
      ? { label: "Ready", tone: "bg-success/15 text-success" }
      : item.status === "FAILED"
        ? { label: "Couldn't read it", tone: "bg-destructive/10 text-destructive" }
        : item.status === "SKIPPED"
          ? { label: "Kept", tone: "bg-muted text-muted-foreground" }
          : { label: "Analyzing…", tone: "bg-muted text-muted-foreground" };

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10",
        item.archived && "opacity-60",
      )}
    >
      <div className="relative aspect-[4/3] bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored photo served by our own route */}
        <img
          src={assetUrl(item.assetId, "card")}
          alt={item.description ?? "Brand photo"}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
        <span
          className={cn(
            "absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            status.tone,
          )}
        >
          {status.label}
        </span>
        {item.hasPeople ? (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-medium">
            <Users className="size-3" /> People
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
          {item.description ??
            (item.status === "PENDING" ? "Reading the photo…" : "No description yet.")}
        </p>
        {item.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.tags.slice(0, 6).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[11px] text-muted-foreground">
            {item.quality !== null ? `Quality ${item.quality}` : ""}
            {item.useCount > 0 ? ` · used ${item.useCount}×` : ""}
          </span>
          <span className="flex items-center gap-0.5">
            {!item.archived && item.status !== "PENDING" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Make a post from this photo"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await makePhotoPostAction(
                      projectId,
                      item.assetId,
                    );
                    if (!result.ok) {
                      toast.error(result.message);
                      return;
                    }
                    router.push(
                      `/projects/${projectId}?work=${encodeURIComponent(result.workId)}`,
                    );
                  })
                }
              >
                <SquarePen className="size-3.5" />
              </Button>
            ) : null}
            {item.status === "FAILED" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Read again"
                disabled={pending}
                onClick={() =>
                  run(
                    () => reanalyzeBrandMediaAction(projectId, item.id),
                    "Reading it again",
                  )
                }
              >
                <RotateCw className="size-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Edit tags"
              disabled={pending}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={item.archived ? "Restore" : "Archive"}
              disabled={pending}
              onClick={() =>
                run(
                  () => archiveBrandMediaAction(projectId, item.id, !item.archived),
                  item.archived ? "Restored" : "Archived",
                )
              }
            >
              {item.archived ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={
                item.useCount > 0
                  ? "Posts were made from it: archive instead"
                  : "Delete"
              }
              disabled={pending || item.useCount > 0}
              onClick={() => {
                if (!window.confirm("Delete this photo for good?")) return;
                run(() => deleteBrandMediaAction(projectId, item.id), "Deleted");
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </span>
        </div>
      </div>
    </article>
  );
}

function EditDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: MediaItem;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tags, setTags] = useState(item.tags.join(", "));
  const [description, setDescription] = useState(item.description ?? "");
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await updateBrandMediaTagsAction(projectId, item.id, {
        tags: tags.split(/[,\n]/),
        description,
      });
      if (result.ok) {
        toast.success("Saved");
        onClose();
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit photo details</DialogTitle>
          <DialogDescription>
            Ideas find this photo by its tags and description. Your edits are
            kept even when the photo is read again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="media-description">
              Description
            </label>
            <Textarea
              id="media-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={300}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="media-tags">
              Tags (comma separated)
            </label>
            <Textarea
              id="media-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
