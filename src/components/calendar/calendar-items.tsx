"use client";

import { memo, type DragEvent, type MouseEvent } from "react";
import { GripVertical, Lock } from "lucide-react";

import type { PostEntry } from "@/lib/calendar/posts";
import { STAGE_META } from "@/lib/calendar/stage";
import type { CalendarItem } from "@/lib/calendar/types";
import { cn } from "@/lib/utils";

import {
  DeliveryMarks,
  ItemThumb,
  StageIcon,
  StagePill,
  TONE_BORDER,
  deliveriesText,
} from "./calendar-bits";

// Panodaki bir parça: sunucu verisi + yalnız istemcide anlamlı "taşınıyor" işareti.
export type BoardItem = CalendarItem & { pending?: boolean };

// Panodaki bir kart: bir post (bütün mecra teslimatlarıyla) ya da postu
// olmayan tek parça. Kimliği ilk teslimatındır (adres, sürükleme, detay).
export type BoardEntry = PostEntry<BoardItem>;

export type DragHandlers = {
  onDragStart: (event: DragEvent, item: BoardEntry) => void;
  onDragEnd: () => void;
};

type ChipProps = {
  item: BoardEntry;
  // Yeni sekmede açma ve sağ tık için gerçek bir adres (?creative=).
  href: string;
  active: boolean;
  dragging: boolean;
  // Hepsi kararlı (useCallback/useMemo) olmalı: kartlar memo'lu, yoksa tek bir
  // sürükleme ya da süzgeç değişimi yüzlerce kartı yeniden render eder.
  drag: DragHandlers;
  onOpen: (id: string) => void;
};

// Başlığı olmayan parçada kısa metin ya da etiket gösterilir.
function headline(item: BoardEntry): string {
  return item.title ?? item.preview ?? item.label;
}

// Birden çok mecralı post: kartta etiket yerine mecra simgeleri durur.
function isMulti(item: BoardEntry): boolean {
  return item.deliveries.length > 1;
}

// Fare üstüne gelince okunan tam durum cümlesi.
function tooltip(item: BoardEntry): string {
  const meta = STAGE_META[item.stage];
  const when =
    item.localDay && item.localTime
      ? `${item.localDay} ${item.localTime}`
      : "No day yet";
  const status = `${meta.label}${item.reason ? ` — ${item.reason}` : ""}`;
  if (isMulti(item)) {
    return [
      headline(item),
      `${when} · ${status}`,
      ...item.deliveries.map(
        (delivery) =>
          `${delivery.label}: ${STAGE_META[delivery.stage].label}`,
      ),
    ].join("\n");
  }
  return [headline(item), `${item.label} · ${when}`, status].join("\n");
}

function ariaLabel(item: BoardEntry): string {
  const when = item.localTime ? `, ${item.localTime}` : "";
  if (isMulti(item)) {
    return `${headline(item)}${when}, ${STAGE_META[item.stage].label}. ${deliveriesText(item.deliveries)}`;
  }
  return `${headline(item)}, ${item.label}${when}, ${STAGE_META[item.stage].label}`;
}

const NEEDS_EXPLANATION = new Set(["failed", "missed", "held"]);

// Düz tıklama paneli sunucuya gitmeden açar; sekmede aç/Cmd+tık adresi kullanır.
function openOnPlainClick(
  event: MouseEvent,
  id: string,
  onOpen: (id: string) => void,
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  onOpen(id);
}

function dragProps(item: BoardEntry, drag: DragHandlers) {
  return {
    draggable: item.movable,
    onDragStart: (event: DragEvent) => drag.onDragStart(event, item),
    onDragEnd: drag.onDragEnd,
  };
}

// Ay görünümü: günün hücresine sığan tek satırlık kart.
export const CompactChip = memo(function CompactChip({
  item,
  href,
  active,
  dragging,
  drag,
  onOpen,
}: ChipProps) {
  const tone = STAGE_META[item.stage].tone;
  return (
    <a
      href={href}
      data-item-id={item.id}
      title={tooltip(item)}
      aria-label={ariaLabel(item)}
      onClick={(event) => openOnPlainClick(event, item.id, onOpen)}
      {...dragProps(item, drag)}
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-l-[3px] bg-card px-1.5 py-1 text-[11px] leading-tight shadow-xs transition-colors hover:bg-accent",
        TONE_BORDER[tone],
        item.movable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        item.pending && "opacity-70",
        active && "ring-2 ring-ring",
      )}
    >
      <ItemThumb
        assetId={item.assetId}
        source={item.source}
        badge={!isMulti(item)}
        className="size-6"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{headline(item)}</span>
        {isMulti(item) ? (
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            {item.overdue ? (
              <span className="shrink-0 font-medium text-destructive">
                Overdue ·
              </span>
            ) : null}
            {item.localTime ? (
              <span className="shrink-0">{item.localTime} ·</span>
            ) : null}
            <DeliveryMarks
              deliveries={item.deliveries}
              ringClassName="ring-card"
            />
          </span>
        ) : (
          <span className="block truncate text-[10px] text-muted-foreground">
            {item.overdue ? (
              <span className="font-medium text-destructive">Overdue · </span>
            ) : null}
            {item.localTime ? `${item.localTime} · ` : ""}
            {item.label}
          </span>
        )}
      </span>
      <StageIcon stage={item.stage} />
    </a>
  );
});

// Hafta ve gün listesi: görsel, saat ve durum yazısı ile zengin kart.
export const RichCard = memo(function RichCard({
  item,
  href,
  active,
  dragging,
  drag,
  onOpen,
}: ChipProps) {
  const tone = STAGE_META[item.stage].tone;
  return (
    <a
      href={href}
      data-item-id={item.id}
      title={tooltip(item)}
      aria-label={ariaLabel(item)}
      onClick={(event) => openOnPlainClick(event, item.id, onOpen)}
      {...dragProps(item, drag)}
      className={cn(
        "block rounded-lg border border-l-4 bg-card p-2 shadow-xs transition-colors hover:bg-accent",
        TONE_BORDER[tone],
        item.movable && "md:cursor-grab md:active:cursor-grabbing",
        dragging && "opacity-40",
        item.pending && "opacity-70",
        active && "ring-2 ring-ring",
      )}
    >
      <div className="flex items-start gap-2">
        <ItemThumb
          assetId={item.assetId}
          source={item.source}
          badge={!isMulti(item)}
          className="size-10"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{headline(item)}</p>
          {isMulti(item) ? (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              {item.localTime ? (
                <span className="shrink-0">{item.localTime} ·</span>
              ) : null}
              <DeliveryMarks
                deliveries={item.deliveries}
                ringClassName="ring-card"
              />
            </p>
          ) : (
            <p className="truncate text-[11px] text-muted-foreground">
              {item.localTime ? `${item.localTime} · ` : ""}
              {item.label}
            </p>
          )}
        </div>
        {item.movable ? (
          <GripVertical
            aria-hidden
            className="hidden size-3.5 shrink-0 text-muted-foreground/50 md:block"
          />
        ) : (
          <Lock
            aria-label="Can't be moved"
            className="size-3 shrink-0 text-muted-foreground/60"
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <StagePill stage={item.stage} />
        {item.overdue ? (
          <span className="text-[11px] font-medium text-destructive">
            Overdue
          </span>
        ) : null}
      </div>
      {item.reason && NEEDS_EXPLANATION.has(item.stage) ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
          {item.reason}
        </p>
      ) : null}
    </a>
  );
});

// "Günü atanmamış" tepsisindeki kare kart.
export const TrayCard = memo(function TrayCard({
  item,
  href,
  active,
  dragging,
  drag,
  onOpen,
}: ChipProps) {
  const tone = STAGE_META[item.stage].tone;
  return (
    <a
      href={href}
      data-item-id={item.id}
      title={tooltip(item)}
      aria-label={ariaLabel(item)}
      onClick={(event) => openOnPlainClick(event, item.id, onOpen)}
      {...dragProps(item, drag)}
      className={cn(
        "flex w-32 shrink-0 items-center gap-2 rounded-lg border border-l-[3px] bg-card p-1.5 shadow-xs transition-colors hover:bg-accent",
        TONE_BORDER[tone],
        item.movable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        item.pending && "opacity-70",
        active && "ring-2 ring-ring",
      )}
    >
      <ItemThumb
        assetId={item.assetId}
        source={item.source}
        badge={!isMulti(item)}
        className="size-8"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">
          {headline(item)}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <StageIcon stage={item.stage} className="size-3" />
          {isMulti(item) ? (
            <DeliveryMarks
              deliveries={item.deliveries}
              ringClassName="ring-card"
            />
          ) : (
            <span className="truncate">{STAGE_META[item.stage].label}</span>
          )}
        </span>
      </span>
    </a>
  );
});
