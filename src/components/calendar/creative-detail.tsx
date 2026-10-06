"use client";

import type { ReactNode } from "react";
import type { CreativeContentFormat, SocialPlatform } from "@prisma/client";

import { ImageLightbox } from "@/components/shared/image-lightbox";
import { formatDayLong } from "@/lib/calendar/grid";
import { STAGE_META, type CalendarStage } from "@/lib/calendar/stage";
import type { CalendarDetail, CalendarItem } from "@/lib/calendar/types";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { cn } from "@/lib/utils";

import {
  SourceMark,
  StageIcon,
  StagePill,
  TONE_CARD,
  TONE_DOT,
} from "./calendar-bits";
import { CopyButton } from "./copy-button";
import { DecisionButtons } from "./decision-buttons";
import { CalendarDetailSheet } from "./detail-sheet";
import { MarkPostedButton } from "./mark-posted-button";
import { SchedulePicker } from "./schedule-picker";
import { assetUrl } from "@/lib/asset-url";

// Elle paylaşılanlar "paylaştım" diye işaretlenebilir.
const MARKABLE: ReadonlySet<CalendarStage> = new Set(["manual", "missed"]);

function Card({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded bg-muted", className)}
      aria-hidden
    />
  );
}

export type DetailState =
  // Yükleniyor
  | undefined
  // Yüklenemedi
  | null
  | CalendarDetail;

// Postun mecraları arasında geçiş: her teslimatın kendi metni, görseli ve
// durumu vardır; zamanı ve onayı postundur.
function DeliverySwitcher({
  deliveries,
  activeId,
  onSwitch,
}: {
  deliveries: readonly CalendarItem[];
  activeId: string;
  onSwitch: (id: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Channels of this post"
      className="scrollbar-none -my-1 flex min-w-0 gap-1 overflow-x-auto py-1"
    >
      {deliveries.map((delivery) => {
        const active = delivery.id === activeId;
        const meta = STAGE_META[delivery.stage];
        return (
          <button
            key={delivery.id}
            type="button"
            aria-pressed={active}
            title={`${delivery.label} · ${meta.label}`}
            onClick={() => {
              if (!active) onSwitch(delivery.id);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap transition-colors",
              active
                ? "border-foreground bg-accent text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <SourceMark
              source={delivery.source}
              decorative
              className={cn(
                "size-4",
                delivery.glyph === "story" && "rounded-full",
              )}
            />
            {delivery.label}
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone])}
            />
            <span className="sr-only">, {meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Takvimdeki bir parçanın sağdan açılan detayı. Kimlik, durum, zaman ve görsel
// pano verisinden ANINDA gelir (sunucuya gitmeden); tam metin, künye ve bekleyen
// onay tembel yüklenir ve gelene kadar iskelet gösterilir. Parça bir postun
// teslimatıysa başlıkta postun mecraları arasında geçilir (`deliveries`,
// `onSwitch`); çağıran, geçişte paneli yeniden kurmasın diye anahtarı post
// başına verir.
export function CreativeDetail({
  item,
  deliveries,
  onSwitch,
  detail,
  projectId,
  timezone,
  onSchedule,
  onClose,
  onDecided,
}: {
  item: CalendarItem;
  // Parçanın postunun bütün teslimatları (parçanın kendisi dahil), varsa.
  deliveries?: readonly CalendarItem[];
  onSwitch?: (creativeId: string) => void;
  detail: DetailState;
  // Planlı gün noktaları için; verilmezse seçici noktasız çalışır.
  projectId?: string;
  timezone: string;
  // Eski çağıranlar için kabul edilir, KULLANILMAZ: seçici "bugün"ü kendi
  // `timezone`undan hesaplar.
  todayKey?: string;
  // localDateTime "YYYY-MM-DDTHH:mm", ya da null: günü kaldır.
  onSchedule: (localDateTime: string | null) => void;
  onClose: () => void;
  // Onay/ret ya da "paylaştım" sonrası: pano taze durumu okusun.
  onDecided: () => void;
}) {
  const meta = STAGE_META[item.stage];
  const loading = detail === undefined;
  const title = item.title ?? item.preview ?? item.label;
  const siblings = deliveries && deliveries.length > 1 ? deliveries : null;
  // Post tek parça taşınır: bir mecrası yayındaysa (ya da şu an gidiyorsa)
  // hiçbirinin günü değişmez.
  const movable =
    item.movable && (siblings ?? []).every((delivery) => delivery.movable);
  const lockNote =
    item.stage === "published"
      ? "Already posted, so its day can't be changed."
      : item.stage === "publishing"
        ? "Being sent right now. Its day can't be changed."
        : siblings?.some((delivery) => delivery.stage === "published")
          ? "Part of this post is already posted, so its day can't be changed."
          : "Part of this post is being sent right now. Its day can't be changed.";
  const dateTime = (iso: string, withTime: boolean) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      ...(withTime ? { timeStyle: "short" as const } : {}),
    }).format(new Date(iso));

  const caption = detail ? detail.caption : null;
  const copy = detail ? detail.copy : null;
  const showCopy = copy !== null && copy !== caption;
  const format = detail
    ? getCreativePlatformFormat(
        detail.platform as SocialPlatform | null,
        detail.contentFormat as CreativeContentFormat | null,
      )
    : null;

  let footer: ReactNode = null;
  if (item.stage === "needs-approval") {
    // Onay kaydı ayrıntıyla gelir; o gelene kadar düğmeler pasif görünür.
    // Postta tek onay yeter: sunucu bekleyen diğer mecraları da onaylar.
    footer =
      loading || detail?.approvalId ? (
        <>
          {siblings ? (
            <p className="mb-2 text-[11px] text-muted-foreground">
              Approving also approves the post&apos;s other channels waiting for
              review.
            </p>
          ) : null}
          <DecisionButtons
            key={item.id}
            approvalId={detail?.approvalId ?? null}
            onDone={onDecided}
          />
        </>
      ) : null;
  } else if (MARKABLE.has(item.stage) && item.facts.status === "APPROVED") {
    // Bu düğme hesaba hiçbir şey göndermez; yalnız "ben paylaştım" der.
    footer = (
      <>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Agentelse can&apos;t post this format for you. Post it on the account
          yourself, then mark it here.
        </p>
        <MarkPostedButton
          key={item.id}
          creativeId={item.id}
          className="w-full"
          onDone={onDecided}
        />
      </>
    );
  }

  return (
    <CalendarDetailSheet
      onClose={onClose}
      eyebrow={
        siblings && onSwitch ? (
          <DeliverySwitcher
            deliveries={siblings}
            activeId={item.id}
            onSwitch={onSwitch}
          />
        ) : (
          <>
            <SourceMark source={item.source} decorative />
            <span className="truncate">{item.label}</span>
          </>
        )
      }
      title={title}
      subline={
        <>
          <StagePill stage={item.stage} />
          <span className="text-xs text-muted-foreground">
            {item.localDay
              ? `${formatDayLong(item.localDay)} · ${item.localTime}`
              : "No day yet"}
          </span>
          {item.overdue ? (
            <span className="text-xs font-medium text-destructive">
              Overdue
            </span>
          ) : null}
        </>
      }
      footer={footer}
    >
      {item.assetId ? (
        <ImageLightbox
          src={assetUrl(item.assetId, "large")}
          alt={detail?.filename ?? title}
          title={title}
          className="block"
        >
          <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={assetUrl(item.assetId, "card")}
              alt=""
              decoding="async"
              className="mx-auto max-h-60 w-full object-contain"
            />
          </div>
        </ImageLightbox>
      ) : null}

      <section
        className={cn(
          "flex items-start gap-2.5 rounded-xl border p-3",
          TONE_CARD[meta.tone],
        )}
      >
        <StageIcon stage={item.stage} className="mt-0.5 size-4" />
        <div className="min-w-0 text-xs">
          <p className="font-medium text-foreground">
            {item.reason ?? meta.hint}
          </p>
          {item.publishedAt ? (
            <p className="mt-0.5 text-muted-foreground">
              Posted {dateTime(item.publishedAt, true)}
            </p>
          ) : null}
        </div>
      </section>

      <Card label="Schedule">
        {movable ? (
          <SchedulePicker
            // Yerel yeni zaman gelince (ya da bir hata onu geri alınca) ya da
            // postun başka mecrasına geçilince alanlar baştan kurulur.
            key={`${item.id}|${item.localDay}T${item.localTime}`}
            projectId={projectId}
            creativeId={item.id}
            timezone={timezone}
            day={item.localDay}
            time={item.localTime}
            onSave={onSchedule}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{lockNote}</p>
        )}
      </Card>

      {loading && item.facts.hasContent ? (
        <Card label="Caption">
          {item.preview ? (
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {item.preview}
            </p>
          ) : (
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          )}
        </Card>
      ) : null}

      {caption ? (
        <Card
          label="Caption"
          aside={<CopyButton text={caption} label="Caption" />}
        >
          <p className="max-h-56 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
            {caption}
          </p>
        </Card>
      ) : null}

      {showCopy && copy ? (
        <Card label="Copy" aside={<CopyButton text={copy} label="Copy" />}>
          <p className="max-h-56 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
            {copy}
          </p>
        </Card>
      ) : null}

      <Card label="Details">
        {loading ? (
          <div className="space-y-2 py-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : (
          <dl className="divide-y divide-border/60">
            <Row label="Platform" value={item.source.label} />
            {format ? (
              <Row
                label="Format"
                value={`${format.label} · ${format.contentFormatLabel}`}
              />
            ) : null}
            {detail?.goal ? (
              <Row
                label="Goal"
                value={
                  detail.goal.charAt(0).toUpperCase() + detail.goal.slice(1)
                }
              />
            ) : null}
            {detail ? (
              <Row label="Created" value={dateTime(detail.createdAt, false)} />
            ) : null}
            {detail?.version ? (
              <Row label="Version" value={`v${detail.version}`} />
            ) : null}
          </dl>
        )}
      </Card>
    </CalendarDetailSheet>
  );
}
