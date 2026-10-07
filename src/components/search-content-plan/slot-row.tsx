import Link from "next/link";

import { SlotMenu } from "@/components/search-content-plan/slot-actions";
import { PublishToWordPress } from "@/components/seo-apply/publish-to-wordpress";
import { buttonVariants } from "@/components/ui/button";
import { PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { cn } from "@/lib/utils";
import type { SlotView } from "@/server/seo/content-plan/store";

// Planın tek satırı (SC-F7): tarih çipi, başlık, durum çipi (renk tek başına
// değil, metin de var), anahtar kelime çipi, en çok 3 "neden" satırı, "Internal
// links" açılırı ve eylemler. Compact kipte (yol haritası kartı) menü ve açılır
// yok. İç kimlikler hiçbir zaman çizilmez (yalnız eylem formlarının gizli
// alanları ve "Write" bağlantısı taşır).

const WHY_MAX = 3;

const STATE_TONE: Readonly<Record<string, string>> = {
  PLANNED: "bg-muted text-muted-foreground",
  IN_PROGRESS: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  SCHEDULED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PUBLISHED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  OVERDUE: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  SKIPPED: "bg-muted text-muted-foreground",
};

function StateChip({ slot }: { slot: SlotView }) {
  return (
    <span
      data-state={slot.state}
      className={cn(
        "inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        STATE_TONE[slot.state] ?? STATE_TONE.PLANNED,
      )}
    >
      {slot.stateLabel}
    </span>
  );
}

function LinkList({
  heading,
  links,
}: {
  heading: string;
  links: SlotView["linkFrom"];
}) {
  if (links.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-medium">{heading}</p>
      <ul className="space-y-0.5 text-muted-foreground">
        {links.map((link) => (
          <li key={`${link.path}:${link.anchor}`} className="truncate">
            <span className="text-foreground">{link.path}</span>
            {link.anchor ? <span>{` · “${link.anchor}”`}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InternalLinks({ slot }: { slot: SlotView }) {
  const empty = slot.linkFrom.length === 0 && slot.linkTo.length === 0;
  if (empty && slot.linksVerified) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium select-none">
        Internal links
      </summary>
      <div className="mt-1.5 space-y-2">
        <LinkList heading="Link to this article from" links={slot.linkFrom} />
        <LinkList heading="The article should link to" links={slot.linkTo} />
        {!slot.linksVerified ? (
          <p className="text-muted-foreground">{PLAN_COPY.noCrawlNote}</p>
        ) : null}
      </div>
    </details>
  );
}

function WriteAction({ slot }: { slot: SlotView }) {
  const href = slot.canContinue
    ? slot.continueHref
    : slot.canWrite
      ? slot.writeHref
      : null;
  if (!href) return null;
  return (
    <Link
      href={href}
      className={buttonVariants({
        size: "xs",
        variant: slot.canContinue ? "outline" : "default",
      })}
    >
      {slot.canContinue ? PLAN_COPY.continueButton : PLAN_COPY.writeButton}
    </Link>
  );
}

// SC-F8: yazılmış (onaylı/yayında) makalesi olan yuvalar WordPress taslağına gidebilir.
const WRITTEN_STATES: ReadonlySet<string> = new Set([
  "SCHEDULED",
  "PUBLISHED",
  "OVERDUE",
]);

export function SlotRow({
  slot,
  projectId,
  month,
  compact = false,
  applyReady = false,
}: {
  slot: SlotView;
  projectId: string;
  month: string;
  compact?: boolean;
  // SC-F8: bölüm bir kez hesaplar; false/yok iken işaretleme aynıdır ve istek yoktur.
  applyReady?: boolean;
}) {
  const skipped = slot.state === "SKIPPED";
  return (
    <li
      data-skipped={skipped ? "true" : undefined}
      className={cn(
        "space-y-2 rounded-xl p-3 ring-1 ring-foreground/10",
        skipped && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span className="inline-flex shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
          {slot.dateLabel || "No date"}
        </span>
        <p
          className={cn(
            "min-w-0 flex-1 basis-48 text-sm font-medium",
            skipped && "line-through",
          )}
        >
          {slot.title}
        </p>
        <StateChip slot={slot} />
      </div>
      {!compact ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex max-w-full truncate rounded-full border border-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {slot.keyword}
            </span>
          </div>
          {slot.why.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {slot.why.slice(0, WHY_MAX).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {!skipped ? <InternalLinks slot={slot} /> : null}
        </>
      ) : null}
      {!skipped ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <WriteAction slot={slot} />
          {!compact ? (
            <SlotMenu
              projectId={projectId}
              slotId={slot.id}
              month={month}
              date={slot.date}
              canMove={slot.canMove}
              canSkip={slot.canSkip}
              canReplace={slot.canReplace}
            />
          ) : null}
        </div>
      ) : null}
      {applyReady && WRITTEN_STATES.has(slot.state) && slot.creativeId ? (
        <PublishToWordPress
          projectId={projectId}
          creativeId={slot.creativeId}
          isManager={false}
          compact
        />
      ) : null}
    </li>
  );
}
