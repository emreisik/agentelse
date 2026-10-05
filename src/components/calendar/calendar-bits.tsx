"use client";

import {
  AlarmClockOff,
  CalendarClock,
  CircleCheck,
  CirclePause,
  CircleX,
  Hand,
  Hourglass,
  ImageOff,
  LoaderCircle,
  PenLine,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { BrandIcon } from "@/components/integrations/brand-icons";
import {
  STAGE_META,
  type CalendarStage,
  type StageTone,
} from "@/lib/calendar/stage";
import type { CalendarItem, CalendarSource } from "@/lib/calendar/types";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/asset-url";

export const STAGE_ICON: Record<CalendarStage, LucideIcon> = {
  failed: TriangleAlert,
  missed: AlarmClockOff,
  held: CirclePause,
  "needs-approval": Hourglass,
  "needs-content": PenLine,
  scheduled: CalendarClock,
  publishing: LoaderCircle,
  manual: Hand,
  published: CircleCheck,
  rejected: CircleX,
};

// Durum tonunun renk sınıfları. Renk tek başına işaret değil: her yerde ikon
// ve metin eşlik eder.
export const TONE_TEXT: Record<StageTone, string> = {
  positive: "text-success",
  active: "text-primary",
  waiting: "text-warning",
  neutral: "text-muted-foreground",
  danger: "text-destructive",
  special: "text-special",
};

export const TONE_BORDER: Record<StageTone, string> = {
  positive: "border-l-success",
  active: "border-l-primary",
  waiting: "border-l-warning",
  neutral: "border-l-muted-foreground/40",
  danger: "border-l-destructive",
  special: "border-l-special",
};

export const TONE_PILL: Record<StageTone, string> = {
  positive: "bg-success/15 text-success ring-success/25",
  active: "bg-primary/10 text-primary ring-primary/20",
  waiting: "bg-warning/15 text-warning ring-warning/25",
  neutral: "bg-muted text-muted-foreground ring-foreground/10",
  danger: "bg-destructive/10 text-destructive ring-destructive/25",
  special: "bg-special/15 text-special ring-special/25",
};

// Küçük durum noktası (dar ekranda gün noktaları, teslimat simgesinin köşesi).
export const TONE_DOT: Record<StageTone, string> = {
  positive: "bg-success",
  active: "bg-primary",
  waiting: "bg-warning",
  neutral: "bg-muted-foreground/50",
  danger: "bg-destructive",
  special: "bg-special",
};

// Detay panelindeki durum kartının hafif tonlu zemini.
export const TONE_CARD: Record<StageTone, string> = {
  positive: "border-success/25 bg-success/5",
  active: "border-primary/20 bg-primary/5",
  waiting: "border-warning/30 bg-warning/5",
  neutral: "border-border bg-muted/30",
  danger: "border-destructive/25 bg-destructive/5",
  special: "border-special/25 bg-special/5",
};

export function StageIcon({
  stage,
  className,
}: {
  stage: CalendarStage;
  className?: string;
}) {
  const Icon = STAGE_ICON[stage];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        TONE_TEXT[STAGE_META[stage].tone],
        stage === "publishing" && "animate-spin",
        className,
      )}
    />
  );
}

export function StagePill({
  stage,
  className,
}: {
  stage: CalendarStage;
  className?: string;
}) {
  const meta = STAGE_META[stage];
  const Icon = STAGE_ICON[stage];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1",
        TONE_PILL[meta.tone],
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-3", stage === "publishing" && "animate-spin")}
      />
      {meta.label}
    </span>
  );
}

// Platformun gerçek marka simgesi; markası olmayanlar (Blog/SEO, Ads...)
// renkli kısa kod rozeti alır.
export function SourceMark({
  source,
  className,
  decorative = false,
}: {
  source: CalendarSource;
  className?: string;
  // Platform adı hemen yanında yazılıysa ekran okuyucuya ikinci kez okutma.
  decorative?: boolean;
}) {
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({
        role: "img",
        "aria-label": source.label,
        title: source.label,
      } as const);
  if (source.brand) {
    return (
      <span
        {...a11y}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
          className,
        )}
      >
        <BrandIcon brand={source.brand} className="size-[70%]" />
      </span>
    );
  }
  return (
    <span
      {...a11y}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md px-0.5 text-[9px] leading-none font-bold text-white",
        className,
      )}
      style={{ background: source.color }}
    >
      {source.short}
    </span>
  );
}

// Parçanın görseli; üstünde platformun küçük marka rozeti. Görsel yoksa
// platform simgesi karoyu doldurur. Birden çok mecralı postta rozet yok
// (`badge={false}`): mecralar kartta DeliveryMarks ile yazılır.
export function ItemThumb({
  assetId,
  source,
  className,
  badge = true,
}: {
  assetId: string | null;
  source: CalendarSource;
  className?: string;
  badge?: boolean;
}) {
  return (
    <span className={cn("relative inline-flex size-8 shrink-0", className)}>
      {assetId ? (
        // eslint-disable-next-line @next/next/no-img-element -- /api/assets/<id>, next/image optimize edemez
        <img
          src={assetUrl(assetId, "thumb")}
          alt=""
          loading="lazy"
          className="size-full rounded-md object-cover ring-1 ring-foreground/10"
        />
      ) : (
        <span className="flex size-full items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-foreground/10">
          <ImageOff className="size-[45%]" aria-hidden />
        </span>
      )}
      {badge ? (
        <SourceMark
          source={source}
          decorative
          className="absolute -right-1 -bottom-1 size-[45%] min-w-3 rounded-full bg-background text-[6px] ring-1 ring-background"
        />
      ) : null}
    </span>
  );
}

// Bir postun teslimatları: her mecranın simgesi, köşesinde o teslimatın kendi
// durumunun küçük noktası. Renk tek işaret değil: durum simgenin başlığında ve
// kartın erişilebilir adında yazılı. Story yuvarlak simgeyle aynı mecradaki
// posttan ayrılır.
export function DeliveryMarks({
  deliveries,
  className,
  ringClassName = "ring-background",
}: {
  deliveries: readonly CalendarItem[];
  className?: string;
  // Noktanın çevresi kartın zeminiyle aynı renk olsun.
  ringClassName?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {deliveries.map((delivery) => {
        const meta = STAGE_META[delivery.stage];
        return (
          <span
            key={delivery.id}
            title={`${delivery.label} · ${meta.label}`}
            className="relative inline-flex"
          >
            <SourceMark
              source={delivery.source}
              decorative
              className={cn(
                "size-3.5 rounded",
                delivery.glyph === "story" && "rounded-full",
              )}
            />
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1",
                TONE_DOT[meta.tone],
                ringClassName,
              )}
            />
          </span>
        );
      })}
    </span>
  );
}

// Postun ekran okuyucu ve başlık (title) metni: her teslimat ve kendi durumu.
export function deliveriesText(deliveries: readonly CalendarItem[]): string {
  return deliveries
    .map((delivery) => `${delivery.label}: ${STAGE_META[delivery.stage].label}`)
    .join("; ");
}
