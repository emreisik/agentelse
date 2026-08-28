import Link from "next/link";
import { Pencil } from "lucide-react";

import { EntitySheet } from "@/components/shared/entity-sheet";
import { StatusBadge } from "@/components/shared/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AdPreviewCard } from "@/components/ads/ad-preview-card";
import type { MetaAdSummary } from "@/server/integrations/meta-client";

function statusTone(status: string): "positive" | "waiting" | "neutral" {
  if (status === "ACTIVE") return "positive";
  if (status === "PAUSED") return "waiting";
  return "neutral";
}

const CTA_LABEL: Record<string, string> = {
  LEARN_MORE: "Learn More",
  SHOP_NOW: "Shop Now",
  SIGN_UP: "Sign Up",
  DOWNLOAD: "Download",
  CONTACT_US: "Contact Us",
  GET_OFFER: "Get Offer",
};

// Read-only full detail for one Ad, driven by ?adDetail=<id> in
// ads/page.tsx — creative content (format/message/link/CTA/carousel cards)
// is new here (see listMetaAds' `creative` field in meta-client.ts). The
// preview always renders as a single image (Meta's `thumbnail_url` is one
// representative image regardless of format, usually the carousel's first
// card) — a CAROUSEL's per-card links/headlines are listed separately below
// since Meta doesn't expose a fetchable per-card image URL here.
export function AdDetailSheet({
  ad,
  pageName,
  closeHref,
  editHref,
}: {
  ad: MetaAdSummary;
  pageName: string;
  closeHref: string;
  editHref: string;
}) {
  const creative = ad.creative;
  const format = creative?.format ?? "SINGLE_IMAGE";
  const ctaLabel = creative?.callToActionType
    ? (CTA_LABEL[creative.callToActionType] ?? creative.callToActionType)
    : "—";

  return (
    <EntitySheet closeHref={closeHref} title={ad.name} description="Ad details">
      <AdPreviewCard
        pageName={pageName}
        message={creative?.message ?? ""}
        link={creative?.link ?? ""}
        callToActionLabel={ctaLabel}
        media={
          format === "VIDEO"
            ? { kind: "video", thumbnailUrl: ad.thumbnailUrl ?? null }
            : { kind: "single", imageUrl: ad.thumbnailUrl ?? null }
        }
      />
      <dl className="divide-y divide-border/60 overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="text-sm font-medium">
            <StatusBadge
              meta={{ label: ad.effectiveStatus, tone: statusTone(ad.status) }}
            />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
          <dt className="text-xs text-muted-foreground">Format</dt>
          <dd className="text-sm font-medium">
            {format === "CAROUSEL"
              ? `Carousel (${creative?.cards?.length ?? 0} cards)`
              : format === "VIDEO"
                ? "Video"
                : "Single image"}
          </dd>
        </div>
        {format !== "CAROUSEL" ? (
          <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
            <dt className="text-xs text-muted-foreground">Destination link</dt>
            <dd className="max-w-[65%] truncate text-right text-sm font-medium">
              {creative?.link ?? "—"}
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
          <dt className="text-xs text-muted-foreground">Call to action</dt>
          <dd className="text-sm font-medium">{ctaLabel}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5">
          <dt className="text-xs text-muted-foreground">Ad ID</dt>
          <dd className="text-sm font-medium">{ad.adId}</dd>
        </div>
      </dl>
      {format === "CAROUSEL" && creative?.cards?.length ? (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Carousel cards
          </p>
          <div className="space-y-2">
            {creative.cards.map((card, index) => (
              <div
                key={index}
                className="rounded-xl bg-muted/30 p-3 ring-1 ring-foreground/10"
              >
                <p className="text-sm font-medium">{card.name || "—"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {card.link || "—"}
                </p>
                {card.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {card.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <Link
        href={editHref}
        className={cn(buttonVariants({ size: "sm" }), "w-full gap-1.5")}
      >
        <Pencil className="size-3.5" /> Edit ad
      </Link>
    </EntitySheet>
  );
}
