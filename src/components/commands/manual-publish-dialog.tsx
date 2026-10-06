"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getManualPublishItemsAction,
  markCreativePublishedAction,
  type ManualPublishItem,
} from "@/server/actions/plan-progress-actions";
import { assetUrl } from "@/lib/asset-url";

// "Publish N": approved pieces the client posts themselves (a Reel, a
// carousel, a blog article, a post on an account that is not connected). The
// piece's text and image are right here to copy; "I posted it myself" closes
// the loop so the plan knows it went out. Nothing here posts to the account:
// the copy says so plainly, a client once took the button for "post it".

export function ManualPublishList({
  items,
  busyId,
  onCopy,
  onPublished,
}: {
  items: readonly ManualPublishItem[];
  busyId?: string;
  onCopy: (item: ManualPublishItem) => void;
  onPublished: (item: ManualPublishItem) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        Nothing is waiting for you to post.
      </p>
    );
  }
  return (
    <ul className="max-h-[60vh] space-y-2.5 overflow-y-auto">
      {items.map((item) => (
        <li
          key={item.id}
          className="space-y-2 rounded-xl border p-3"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <div className="flex items-start gap-3">
            {item.assetId ? (
              // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
              <img
                src={assetUrl(item.assetId, "thumb")}
                alt=""
                className="size-14 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {item.title}
              </p>
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {item.where}
                {item.date ? ` · ${item.date}` : ""}
              </p>
            </div>
          </div>
          {item.text ? (
            <p
              className="line-clamp-3 text-xs leading-relaxed whitespace-pre-line"
              style={{ color: "var(--ws-text-2)" }}
            >
              {item.text}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {item.text ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onCopy(item)}
              >
                <Copy className="size-3.5" />
                Copy text
              </Button>
            ) : null}
            {item.assetId ? (
              <a
                href={`/api/assets/${item.assetId}`}
                download
                className="inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[0.8rem] font-medium hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
              >
                <Download className="size-3.5" />
                Download image
              </a>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={busyId !== undefined}
              onClick={() => onPublished(item)}
            >
              {busyId === item.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              I posted it myself
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ManualPublishDialog({
  projectId,
  creativeIds,
  onClose,
}: {
  projectId: string;
  creativeIds: readonly string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ManualPublishItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void getManualPublishItemsAction(projectId, [...creativeIds]).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) setItems(result.items);
        else setError(result.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, creativeIds]);

  const copy = (item: ManualPublishItem) => {
    navigator.clipboard.writeText(item.text).then(
      () => toast.success("Text copied."),
      () => toast.error("Could not copy. Select the text and copy it."),
    );
  };

  const published = async (item: ManualPublishItem) => {
    setBusyId(item.id);
    const result = await markCreativePublishedAction(item.id);
    setBusyId(undefined);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success("Marked as posted by you.");
    const rest = (items ?? []).filter((candidate) => candidate.id !== item.id);
    setItems(rest);
    router.refresh();
    if (rest.length === 0) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Post these yourself</DialogTitle>
          <DialogDescription>
            Agentelse can&apos;t post these formats for you, so nothing is sent
            to the account from here. Copy the text, download the image, post it
            on the account, then mark it as posted.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm" style={{ color: "var(--destructive)" }}>
            {error}
          </p>
        ) : items === null ? (
          <Loader2 className="mx-auto size-5 animate-spin" />
        ) : (
          <ManualPublishList
            items={items}
            busyId={busyId}
            onCopy={copy}
            onPublished={(item) => void published(item)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
