"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Check, ImageIcon, Loader2, Share2 } from "lucide-react";

import { CREATIVE_STATUS, stripCapabilityPrefix } from "@/lib/labels/core";
import { StatusBadge } from "@/components/shared/status-badge";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { Button } from "@/components/ui/button";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import {
  getCreativePublishTargetsAction,
  publishCreativeToInstagramAction,
} from "@/server/actions/publish-actions";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";
import type { CreativeCardData } from "@/types/creative-card";

// Bir kreatif/görsel üretim olayının sohbetteki görsel temsili — ChatGPT'nin
// görsel üretirken gösterdiği "yükleniyor" → sonuç kartı geçişiyle aynı
// mantık. thread.tsx'teki AssistantMessage, mesajın metadata.custom.card
// alanında bunu bulunca normal metin/parça render'ının YERİNE bu kartı
// gösterir (bkz. isCreativeCardData).
export function CreativeCard({ card }: { card: CreativeCardData }) {
  if (card.kind === "creative-loading") {
    return (
      <div className="mt-1 w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card">
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted via-muted/60 to-muted" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs font-medium">Görsel oluşturuluyor…</span>
          </div>
        </div>
        <div className="px-3.5 py-2.5">
          <p className="truncate text-sm font-medium text-foreground">
            {stripCapabilityPrefix(card.title)}
          </p>
        </div>
      </div>
    );
  }

  if (card.kind === "creative-failed") {
    return (
      <div className="mt-1 flex w-full max-w-sm items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            Görsel üretilemedi
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {stripCapabilityPrefix(card.title)}
          </p>
        </div>
      </div>
    );
  }

  if (card.kind === "publish-prompt") {
    return (
      <div className="mt-1 w-full max-w-sm space-y-2 rounded-2xl border border-border bg-card p-3.5">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Share2 className="size-3.5" />
          </span>
          <p className="text-sm font-medium text-foreground">
            {stripCapabilityPrefix(card.title)} onaylandı — sosyal medyada
            paylaşmak ister misiniz?
          </p>
        </div>
        <PublishSection creativeId={card.creativeId} />
      </div>
    );
  }

  return <CreativeReadyCard card={card} />;
}

// "creative-ready" kartı için ayrı bileşen — sadece bu dalda hook
// gerekiyor (onay durumu/geçiş), loading/failed dallarını hook kurallarını
// bozmadan basit tutmak için ayrıldı.
function CreativeReadyCard({
  card,
}: {
  card: Extract<CreativeCardData, { kind: "creative-ready" }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const src = card.assetId ? `/api/assets/${card.assetId}` : undefined;
  const isImage = card.mimeType?.startsWith("image/") ?? Boolean(src);
  const status = localStatus ?? card.status;
  const canDecide = status === "IN_REVIEW" && Boolean(card.approvalId);
  const title = stripCapabilityPrefix(card.title);

  const decide = (to: "APPROVED" | "REJECTED") => {
    if (!card.approvalId) return;
    setError(undefined);
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("approvalId", card.approvalId!);
        const action =
          to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
        const result = await action(formData);
        if (result.ok) {
          setLocalStatus(to);
          toast.success(to === "APPROVED" ? "Onaylandı" : "Reddedildi");
          router.refresh();
        } else {
          setError(result.message);
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "İşlem başarısız";
        setError(message);
        toast.error(message);
      }
    });
  };

  return (
    <div className="mt-1 w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card">
      {src && isImage ? (
        <ImageLightbox
          src={src}
          alt={card.caption || title}
          title={title}
          className="block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- kaynak /api/assets/<id>, next/image optimize edemez */}
          <img
            src={src}
            alt={card.caption || title}
            className="aspect-square w-full object-cover"
          />
        </ImageLightbox>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center bg-muted text-muted-foreground">
          <ImageIcon className="size-6" />
        </div>
      )}
      <div className="space-y-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-semibold text-foreground">
            {card.caption || title}
          </p>
          <StatusBadge
            meta={CREATIVE_STATUS[status as keyof typeof CREATIVE_STATUS]}
            fallback={status}
          />
        </div>
        {card.copy ? (
          <p className="text-sm whitespace-pre-line text-muted-foreground">
            {card.copy}
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {canDecide ? (
          <div className="flex gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={isPending}
              onClick={() => decide("REJECTED")}
            >
              Reddet
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending}
              className="rounded-full bg-success text-success-foreground hover:bg-success/90"
              onClick={() => decide("APPROVED")}
            >
              Onayla
            </Button>
          </div>
        ) : null}
        {status === "APPROVED" ? (
          <PublishSection creativeId={card.creativeId} />
        ) : null}
      </div>
    </div>
  );
}

// Onaylanmış kreatiften sonraki adım: hangi bağlı sosyal hesaplara
// gönderilebileceğini göstermek. Composer'daki eski gizli "hızlı işlemler"
// menüsünün yerine geçti — kart yalnızca creativeId biliyor,
// approveApprovalAction'ın approvalId'den self-contained çalışması gibi
// projectId/ideaId burada server tarafında creativeId'den çözülüyor.
type PublishFormat = "FEED" | "STORIES";
const FORMAT_LABEL: Record<PublishFormat, string> = {
  FEED: "Gönderi",
  STORIES: "Story",
};

function PublishSection({ creativeId }: { creativeId: string }) {
  const [targets, setTargets] = useState<PublishTarget[] | null>(null);
  const [publishedKeys, setPublishedKeys] = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCreativePublishTargetsAction(creativeId).then((result) => {
      if (!cancelled) setTargets(result);
    });
    return () => {
      cancelled = true;
    };
  }, [creativeId]);

  if (targets === null) return null;

  if (targets.length === 0) {
    return (
      <p className="pt-0.5 text-xs text-muted-foreground">
        Henüz bağlı bir sosyal hesap yok.
      </p>
    );
  }

  const publish = (target: PublishTarget, format: PublishFormat) => {
    const key = `${target.pageId}:${format}`;
    setPendingKey(key);
    publishCreativeToInstagramAction(creativeId, format)
      .then((result) => {
        if (result.ok) {
          toast.success(result.message);
          setPublishedKeys((prev) => new Set(prev).add(key));
        } else {
          toast.error(result.message);
        }
      })
      .finally(() => setPendingKey(null));
  };

  return (
    <div className="space-y-1.5 border-t border-border pt-2.5">
      <p className="text-xs font-medium text-muted-foreground">
        Sosyal Hesaplarda Paylaş
      </p>
      {targets.map((target) => (
        <div
          key={target.pageId}
          className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">
              {target.pageName}
            </p>
            {target.igUsername ? (
              <p className="truncate text-[11px] text-muted-foreground">
                @{target.igUsername}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1">
            {(["FEED", "STORIES"] as const).map((format) => {
              const key = `${target.pageId}:${format}`;
              const isPublished = publishedKeys.has(key);
              const isPending = pendingKey === key;
              return (
                <Button
                  key={format}
                  type="button"
                  variant={isPublished ? "ghost" : "outline"}
                  size="sm"
                  className="h-7 rounded-full px-2 text-xs"
                  disabled={isPending || isPublished}
                  onClick={() => publish(target, format)}
                >
                  {isPublished ? (
                    <Check className="size-3.5" />
                  ) : isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Share2 className="size-3.5" />
                  )}
                  {isPublished ? "Gönderildi" : FORMAT_LABEL[format]}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
