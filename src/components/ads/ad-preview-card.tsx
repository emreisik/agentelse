"use client";

import { useState } from "react";
import { Globe, ImageIcon, MoreHorizontal, Play, ThumbsUp } from "lucide-react";

import { cn } from "@/lib/utils";

// A locally-drawn mockup of a Facebook/Instagram feed post — NOT Meta's real
// Ads Preview API (that needs OAuth scopes for a creative that already
// exists on Meta's side; nothing here has been sent to Meta yet while the
// wizard is still open, so a live API preview isn't available). Purely
// illustrative: gives the user a rough, live-updating sense of what the ad
// will look like as they fill in the form, mirroring — not replicating —
// the real feed layout.
export type AdPreviewMedia =
  | { kind: "single"; imageUrl: string | null }
  | { kind: "carousel"; cards: { imageUrl: string | null; name: string }[] }
  | {
      kind: "video";
      thumbnailUrl: string | null;
      // Meta's playable file; without it the card shows the cover only.
      videoUrl?: string | null;
    };

export function AdPreviewCard({
  pageName,
  message,
  link,
  callToActionLabel,
  media,
}: {
  pageName: string;
  message: string;
  link: string;
  callToActionLabel: string;
  media: AdPreviewMedia;
}) {
  const domain = extractDomain(link);
  return (
    <div className="w-full max-w-sm overflow-hidden rounded-xl bg-background ring-1 ring-foreground/10">
      <div className="flex items-center gap-2.5 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {pageName.trim().charAt(0).toUpperCase() || "P"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {pageName || "Your Page"}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Sponsored <span aria-hidden="true">·</span>
            <Globe className="size-2.5" />
          </p>
        </div>
        <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
      </div>

      {message ? (
        <p className="px-3 pb-2.5 text-sm whitespace-pre-wrap text-foreground">
          {message}
        </p>
      ) : null}

      <PreviewMedia media={media} />

      <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2.5">
        <div className="min-w-0">
          {domain ? (
            <p className="truncate text-[10px] tracking-wide text-muted-foreground uppercase">
              {domain}
            </p>
          ) : null}
          <p className="truncate text-xs font-medium text-foreground">
            {message ? message.slice(0, 40) : "Your ad headline"}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-foreground/10 px-2.5 py-1.5 text-xs font-medium text-foreground">
          {callToActionLabel}
        </span>
      </div>

      <div className="flex items-center justify-around border-t border-border/60 py-1.5 text-muted-foreground">
        <span className="flex items-center gap-1.5 text-xs">
          <ThumbsUp className="size-3.5" /> Like
        </span>
        <span className="text-xs">Comment</span>
        <span className="text-xs">Share</span>
      </div>
    </div>
  );
}

function PreviewMedia({ media }: { media: AdPreviewMedia }) {
  if (media.kind === "single") {
    return <SquareImage url={media.imageUrl} />;
  }
  if (media.kind === "video") {
    if (media.videoUrl) {
      return (
        <div className="aspect-square w-full bg-black">
          <video
            src={media.videoUrl}
            poster={media.thumbnailUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="size-full object-contain"
          />
        </div>
      );
    }
    return (
      <div className="relative aspect-square w-full bg-muted">
        {media.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.thumbnailUrl}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <EmptyMedia />
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-background/80">
            <Play className="size-5 translate-x-0.5 fill-foreground text-foreground" />
          </div>
        </div>
      </div>
    );
  }
  return <CarouselPreview cards={media.cards} />;
}

function SquareImage({ url }: { url: string | null }) {
  if (!url) return <EmptyMedia />;
  return (
    <div className="aspect-square w-full bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="size-full object-cover" />
    </div>
  );
}

function EmptyMedia() {
  return (
    <div className="flex aspect-square w-full items-center justify-center bg-muted text-muted-foreground">
      <ImageIcon className="size-8" strokeWidth={1.5} />
    </div>
  );
}

function CarouselPreview({
  cards,
}: {
  cards: { imageUrl: string | null; name: string }[];
}) {
  const [active, setActive] = useState(0);
  if (cards.length === 0) return <EmptyMedia />;
  const current = cards[Math.min(active, cards.length - 1)]!;
  return (
    <div>
      <div className="relative aspect-square w-full bg-muted">
        {current.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.imageUrl}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <EmptyMedia />
        )}
        {current.name ? (
          <p className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2.5 py-2 text-xs font-medium text-white">
            {current.name}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-center gap-1.5 py-2">
        {cards.map((card, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActive(index)}
            aria-label={`Show card ${index + 1}`}
            className={cn(
              "size-1.5 rounded-full transition-colors",
              index === active ? "bg-primary" : "bg-foreground/15",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function extractDomain(link: string): string | null {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
