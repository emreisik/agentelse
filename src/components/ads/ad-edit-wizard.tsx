"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, Video } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AdPreviewCard,
  type AdPreviewMedia,
} from "@/components/ads/ad-preview-card";
import { useObjectUrl, useObjectUrls } from "@/lib/use-object-url";
import { updateMetaAdAction } from "@/server/actions/meta-ads-actions";
import type { MetaAdSummary } from "@/server/integrations/meta-client";

const CALL_TO_ACTIONS = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD",
  "CONTACT_US",
  "GET_OFFER",
] as const;
const CTA_LABEL: Record<(typeof CALL_TO_ACTIONS)[number], string> = {
  LEARN_MORE: "Learn More",
  SHOP_NOW: "Shop Now",
  SIGN_UP: "Sign Up",
  DOWNLOAD: "Download",
  CONTACT_US: "Contact Us",
  GET_OFFER: "Get Offer",
};

type EditCardState = {
  // Stable per-card identity for React's list `key` — NOT the array index.
  // Removing a card shifts every later card's index, and an index-keyed row
  // (holding an uncontrolled <input type="file">) would have React reuse
  // that DOM node for a different card, letting the browser's native
  // "chosen file" label visually lag one render behind the card it now
  // represents.
  id: string;
  link: string;
  name: string;
  description: string;
  // A card carried over from the ad's CURRENT creative starts with its
  // existingImageHash and no local File — its image is only re-uploaded if
  // the user explicitly replaces it. A card added during this edit has no
  // existing hash, so it always needs a fresh image.
  existingImageHash?: string;
  image: File | null;
};

let cardIdCounter = 0;
function nextCardId(): string {
  cardIdCounter += 1;
  return `edit-card-${cardIdCounter}`;
}

// Edits an EXISTING ad's name/status/creative. Deliberately keeps the ad's
// CURRENT format fixed (no format-switcher here, unlike the create wizard)
// — Meta's real Ads Manager treats a format change as "make a new ad", not
// an edit, and supporting arbitrary format transitions here would mean
// every image/video slot needs its own from-scratch upload anyway (an
// existing hash/video only carries over within the SAME format), so fixing
// the format keeps the "don't force re-uploading what didn't change"
// promise intact for the common case: editing text, or swapping one image/
// video/card without touching everything else.
export function AdEditWizard({
  projectId,
  ad,
  closeHref,
  pageName,
}: {
  projectId: string;
  ad: MetaAdSummary;
  closeHref: string;
  pageName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const format = ad.creative?.format ?? "SINGLE_IMAGE";
  // Meta's real ad status can be far more than ACTIVE/PAUSED (ARCHIVED,
  // DELETED, PENDING_REVIEW, DISAPPROVED, ...) — normalizing BOTH the
  // initial state AND the submit-time "did the user touch this" comparison
  // through this SAME value (never the raw ad.status) means an ad sitting
  // in one of those other states doesn't get silently flipped to PAUSED by
  // an edit that never touched the status control at all.
  const normalizedOriginalStatus: "ACTIVE" | "PAUSED" =
    ad.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const [name, setName] = useState(ad.name);
  const [status, setStatus] = useState<"ACTIVE" | "PAUSED">(
    normalizedOriginalStatus,
  );
  const [message, setMessage] = useState(ad.creative?.message ?? "");
  const [link, setLink] = useState(ad.creative?.link ?? "");
  const [callToActionType, setCallToActionType] = useState(
    ad.creative?.callToActionType ?? "LEARN_MORE",
  );

  // SINGLE_IMAGE state
  const [image, setImage] = useState<File | null>(null);
  const imagePreviewUrl = useObjectUrl(image);

  // CAROUSEL state
  const [cards, setCards] = useState<EditCardState[]>(
    () =>
      ad.creative?.cards?.map((c) => ({
        id: nextCardId(),
        link: c.link,
        name: c.name,
        description: c.description ?? "",
        existingImageHash: c.imageHash,
        image: null,
      })) ?? [
        { id: nextCardId(), link: "", name: "", description: "", image: null },
        { id: nextCardId(), link: "", name: "", description: "", image: null },
      ],
  );
  // Memoized on `cards` itself (a stable useState reference between
  // unrelated re-renders) — a bare `cards.map(...)` here would allocate a
  // NEW array on every render of this component (e.g. typing in the name
  // field), and since useObjectUrls' effect depends on array identity, that
  // fresh-every-render array combined with its own setState would loop the
  // component forever from mount, for every ad format (contrast with
  // adset-ad-wizard.tsx, which keeps its own cardImages in useState).
  const cardImages = useMemo(() => cards.map((c) => c.image), [cards]);
  const cardPreviewUrls = useObjectUrls(cardImages);

  // VIDEO state
  const [video, setVideo] = useState<File | null>(null);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const thumbnailPreviewUrl = useObjectUrl(thumbnail);

  const [error, setError] = useState<string | null>(null);

  function updateCard(index: number, patch: Partial<EditCardState>) {
    setCards((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  }
  function addCard() {
    if (cards.length >= 10) return;
    setCards((prev) => [
      ...prev,
      { id: nextCardId(), link: "", name: "", description: "", image: null },
    ]);
  }
  function removeCard(index: number) {
    if (cards.length <= 2) return;
    setCards((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSubmit() {
    setError(null);
    setSubmitError(null);

    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("adId", ad.adId);
    if (name.trim() && name.trim() !== ad.name)
      formData.set("name", name.trim());
    if (status !== normalizedOriginalStatus) formData.set("status", status);

    // Carousel has no top-level `link` (it's per-card) — comparing it here
    // for every format, including CAROUSEL, would compare the empty local
    // `link` state against undefined and could spuriously read as
    // "unchanged" either way, so it's only meaningful for the other two
    // formats.
    const originalCards = ad.creative?.cards ?? [];
    const cardsChanged =
      format === "CAROUSEL" &&
      (cards.length !== originalCards.length ||
        cards.some((c, i) => {
          const original = originalCards[i];
          if (!original) return true; // a newly added card
          return (
            c.image !== null ||
            c.link.trim() !== original.link ||
            c.name.trim() !== original.name ||
            c.description.trim() !== (original.description ?? "")
          );
        }));

    const creativeChanged =
      message.trim() !== (ad.creative?.message ?? "") ||
      (format !== "CAROUSEL" && link.trim() !== (ad.creative?.link ?? "")) ||
      callToActionType !== (ad.creative?.callToActionType ?? "LEARN_MORE") ||
      (format === "SINGLE_IMAGE" && image !== null) ||
      (format === "VIDEO" && (video !== null || thumbnail !== null)) ||
      cardsChanged;

    if (!creativeChanged) {
      if (!formData.has("name") && !formData.has("status")) {
        setError("Nothing to update");
        return;
      }
      submit(formData);
      return;
    }

    if (!message.trim()) {
      setError("Primary text is required");
      return;
    }
    formData.set("format", format);
    formData.set("message", message.trim());
    formData.set("callToActionType", callToActionType);

    if (format === "CAROUSEL") {
      if (cards.length < 2) {
        setError("At least 2 cards are required");
        return;
      }
      for (const c of cards) {
        if (!c.link.trim() || !c.name.trim()) {
          setError("Every card needs a headline and a link");
          return;
        }
        if (!c.image && !c.existingImageHash) {
          setError(`Card "${c.name}" needs an image`);
          return;
        }
      }
      const cardsJson = cards.map((c) => ({
        link: c.link.trim(),
        name: c.name.trim(),
        ...(c.description.trim() ? { description: c.description.trim() } : {}),
        hasNewImage: c.image !== null,
        ...(c.image ? {} : { existingImageHash: c.existingImageHash }),
      }));
      formData.set("cards", JSON.stringify(cardsJson));
      cards.forEach((c) => {
        if (c.image) formData.append("cardImage", c.image);
      });
    } else if (format === "VIDEO") {
      if (!link.trim()) {
        setError("Destination link is required");
        return;
      }
      if (!thumbnail) {
        setError("A thumbnail image is required");
        return;
      }
      formData.set("link", link.trim());
      formData.set("thumbnail", thumbnail);
      if (video) {
        formData.set("video", video);
      } else if (ad.creative?.videoId) {
        formData.set("existingVideoId", ad.creative.videoId);
      } else {
        setError("A video is required");
        return;
      }
    } else {
      if (!link.trim()) {
        setError("Destination link is required");
        return;
      }
      formData.set("link", link.trim());
      if (image) {
        formData.set("image", image);
      } else if (ad.creative?.imageHash) {
        formData.set("existingImageHash", ad.creative.imageHash);
      } else {
        setError("An image is required");
        return;
      }
    }

    submit(formData);
  }

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await updateMetaAdAction(formData);
      if (result.ok) {
        toast.success("Ad update submitted for approval");
        router.push(closeHref);
        router.refresh();
      } else {
        setSubmitError(result.message);
      }
    });
  }

  const previewMedia: AdPreviewMedia =
    format === "CAROUSEL"
      ? {
          kind: "carousel",
          cards: cards.map((c, i) => ({
            imageUrl: cardPreviewUrls[i] ?? null,
            name: c.name,
          })),
        }
      : format === "VIDEO"
        ? {
            kind: "video",
            thumbnailUrl: thumbnailPreviewUrl ?? ad.thumbnailUrl ?? null,
          }
        : {
            kind: "single",
            imageUrl: imagePreviewUrl ?? ad.thumbnailUrl ?? null,
          };

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Ad name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={status}
              onValueChange={(v) =>
                setStatus(v === "ACTIVE" ? "ACTIVE" : "PAUSED")
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                <SelectItem value="PAUSED">PAUSED</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Primary text</Label>
          <Textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>

        {format !== "CAROUSEL" ? (
          <div className="space-y-1.5">
            <Label>Destination link</Label>
            <Input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label>Call to action</Label>
          <Select
            value={callToActionType}
            onValueChange={(v) => setCallToActionType(v ?? "LEARN_MORE")}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CALL_TO_ACTIONS.map((v) => (
                <SelectItem key={v} value={v}>
                  {CTA_LABEL[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {format === "SINGLE_IMAGE" ? (
          <div className="space-y-1.5">
            <Label>Image</Label>
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imagePreviewUrl ?? ad.thumbnailUrl ?? undefined}
                alt=""
                className="size-16 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10"
              />
              <div className="min-w-0 flex-1">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                  className="w-full text-xs"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {image ? image.name : "Current image kept unless replaced."}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {format === "VIDEO" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Video</Label>
              <div className="flex items-center gap-3">
                <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Video className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
                    className="w-full text-xs"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {video ? video.name : "Current video kept unless replaced."}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>
                Thumbnail{" "}
                <span className="font-normal text-muted-foreground">
                  (required every time)
                </span>
              </Label>
              <div className="flex items-center gap-3">
                {thumbnailPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbnailPreviewUrl}
                    alt=""
                    className="size-16 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10"
                  />
                ) : (
                  <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Video className="size-5" />
                  </div>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setThumbnail(e.target.files?.[0] ?? null)}
                  className="w-full text-xs"
                />
              </div>
            </div>
          </div>
        ) : null}

        {format === "CAROUSEL" ? (
          <div className="space-y-3">
            {cards.map((card, index) => (
              <div
                key={card.id}
                className="space-y-2.5 rounded-xl bg-muted/30 p-3 ring-1 ring-foreground/10"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Card {index + 1}
                  </span>
                  {cards.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => removeCard(index)}
                      className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove card ${index + 1}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="flex items-start gap-3">
                  {cardPreviewUrls[index] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cardPreviewUrls[index]!}
                      alt=""
                      className="size-14 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10"
                    />
                  ) : (
                    <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted text-[10px] text-muted-foreground ring-1 ring-foreground/10">
                      {card.existingImageHash ? "Current" : "No image"}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      value={card.name}
                      onChange={(e) =>
                        updateCard(index, { name: e.target.value })
                      }
                      placeholder="Headline"
                    />
                    <Input
                      type="url"
                      value={card.link}
                      onChange={(e) =>
                        updateCard(index, { link: e.target.value })
                      }
                      placeholder="https://example.com/item"
                    />
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) =>
                        updateCard(index, {
                          image: e.target.files?.[0] ?? null,
                        })
                      }
                      className="w-full text-xs"
                    />
                  </div>
                </div>
              </div>
            ))}
            {cards.length < 10 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCard}
                className="w-full"
              >
                <Plus /> Add card
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {submitError ? (
          <p className="text-sm text-destructive">{submitError}</p>
        ) : null}

        <div className="flex justify-end border-t border-border/60 pt-4">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={handleSubmit}
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      </div>
      <div className="hidden md:sticky md:top-0 md:block md:self-start">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Preview
        </p>
        <AdPreviewCard
          pageName={pageName}
          message={message}
          link={format !== "CAROUSEL" ? link : ""}
          callToActionLabel={
            CTA_LABEL[callToActionType as (typeof CALL_TO_ACTIONS)[number]] ??
            callToActionType
          }
          media={previewMedia}
        />
      </div>
    </div>
  );
}
