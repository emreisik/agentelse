"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { copyText } from "@/lib/works/copy";
import { adoptCreativeVariantAction } from "@/server/actions/creative-variant-actions";
import type { CreativeCardData } from "@/types/creative-card";
import { assetUrl } from "@/lib/asset-url";

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

// The pictures of one piece in review: the current one and its alternatives.
// Picking is only possible before approval; afterwards nothing is interactive.
// It never makes new pictures ("Make 3 more" is gone: one post, one picture).
export function CreativeVariantsStrip({ card }: { card: ReadyCard }) {
  const host = useWorkCardHost();
  const guard = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<number | null>(null);

  const alternatives = card.alternatives ?? [];
  if (!card.assetId) return null;

  const pictures = [
    { assetId: card.assetId, current: true },
    ...alternatives.map((a) => ({ assetId: a.assetId, current: false })),
  ];
  const n = pictures.length;
  const inReview = card.status === "IN_REVIEW";

  if (!inReview) {
    // Locked: a muted note and the picture itself, no control.
    if (alternatives.length === 0) return null;
    return (
      <div data-variants-strip="locked" className="mt-2 space-y-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
        <img
          src={assetUrl(card.assetId, "thumb")}
          alt={copyText("variants.alt", { i: 1, n })}
          className="h-20 w-20 rounded-lg object-cover"
        />
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {copyText("variants.locked")}
        </p>
      </div>
    );
  }

  // Nothing to pick: no empty shell.
  if (alternatives.length === 0) return null;
  const blocked = host ? disabledReasonOf(host, { kind: "server" }) : null;
  const disabled = blocked !== null || busy !== null;

  const adopt = async (assetId: string): Promise<void> => {
    if (guard.current || blocked) return;
    guard.current = true;
    setBusy(assetId);
    setError(null);
    try {
      const result = await adoptCreativeVariantAction(card.creativeId, assetId);
      if (!result.ok) {
        setError(
          result.code === "LOCKED"
            ? copyText("variants.locked")
            : result.message || copyText("variants.failed"),
        );
        return;
      }
      // The action revalidates the page: no router.refresh.
      host?.announce(copyText("variants.adopted"));
    } catch {
      setError(copyText("variants.failed"));
    } finally {
      guard.current = false;
      setBusy(null);
    }
  };

  const reasonId = `variants-reason-${card.creativeId}`;
  const shown = enlarged !== null ? pictures[enlarged] : undefined;

  return (
    <div data-variants-strip="review" className="mt-2 space-y-2">
      <ul className="flex flex-wrap gap-3">
          {pictures.map((picture, index) => {
            const i = index + 1;
            return (
              <li key={picture.assetId} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  aria-label={copyText("a11y.enlarge", { i, n })}
                  onClick={() => setEnlarged(index)}
                  className="overflow-hidden rounded-lg border"
                  style={{ borderColor: "var(--ws-border)" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
                  <img
                    src={assetUrl(picture.assetId, "thumb")}
                    loading="lazy"
                    decoding="async"
                    alt={copyText("variants.alt", { i, n })}
                    className="h-24 w-24 object-cover"
                  />
                </button>
                {picture.current ? (
                  <span
                    data-current
                    className="text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {copyText("variants.current")}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={copyText("variants.useAria", { i, n })}
                    aria-disabled={disabled ? "true" : undefined}
                    aria-describedby={blocked ? reasonId : undefined}
                    onClick={() => {
                      if (!disabled) void adopt(picture.assetId);
                    }}
                    className={`min-h-11 rounded-lg px-3 ${disabled ? "opacity-50" : ""}`}
                  >
                    {busy === picture.assetId ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    {copyText("variants.use")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      <p
        data-variants-footnote
        className="text-xs"
        style={{ color: "var(--ws-text-2)" }}
      >
        {copyText("variants.pickBefore")}
      </p>
      {blocked ? (
        <p
          id={reasonId}
          className="text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          {blocked}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {error}
        </p>
      ) : null}
      <Dialog
        open={shown !== undefined}
        onOpenChange={(open) => {
          if (!open) setEnlarged(null);
        }}
      >
        <DialogContent
          showCloseButton
          className="w-full max-w-[calc(100%-2rem)] p-3 sm:max-w-[640px]"
          style={{ background: "var(--ws-surface)", maxHeight: "90dvh" }}
        >
          <DialogTitle className="sr-only">
            {copyText("variants.alt", { i: (enlarged ?? 0) + 1, n })}
          </DialogTitle>
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
            <img
              src={assetUrl(shown.assetId, "large")}
              alt={copyText("variants.alt", { i: (enlarged ?? 0) + 1, n })}
              className="max-h-[80dvh] w-full rounded-lg object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
