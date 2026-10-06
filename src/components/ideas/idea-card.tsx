"use client";

import {
  CalendarDays,
  Camera,
  Check,
  Clock,
  Gem,
  Lightbulb,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Search,
  Sparkles,
  Star,
  ThumbsUp,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { LayoutPreview } from "@/components/brand/layout-preview";
import { WsStatusPill } from "@/components/commands/ws-event-card";
import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { assetUrl } from "@/lib/asset-url";
import {
  buildBrandKit,
  kitLayoutPalette,
  type BrandKit,
} from "@/lib/brand-kit";
import { boardStatusOf, type BoardIdea } from "@/lib/ideas/board";
import {
  DISMISS_REASONS,
  strengthOf,
  type AdIdeaConcept,
  type DismissReason,
  type IdeaSource,
  type SeoIdeaConcept,
  type SocialIdeaConcept,
} from "@/lib/ideas/concept";
import {
  ideaLayoutOf,
  previewFormatOf,
  previewLogosOf,
} from "@/lib/ideas/preview";
import { cn } from "@/lib/utils";
import { FORMAT_CHIP, IDEAS_COPY as COPY } from "./copy";

// One idea on the Ideas board (docs/ideas.md), drawn as the thing it becomes:
// a post idea as the post (the brand's real layout, colours, logo and the
// words on the picture), an article idea as its search result, an ad idea as
// the sponsored post. Pure view: every action is a prop.

export type IdeaCardContext = {
  kit: BrandKit | null;
  brandName: string;
  handle: string | null;
  fontFamily?: string;
  timezone: string;
  now: Date;
};

export type IdeaCardHandlers = {
  onOpen?: (id: string) => void;
  onMake?: (id: string) => void;
  onSave?: (id: string, saved: boolean) => void;
  onAngle?: (id: string) => void;
  onDismiss?: (id: string, reason: DismissReason) => void;
  onArchive?: (id: string) => void;
  onConvert?: (id: string) => void;
  onPlanInChat?: (id: string) => void;
  onWriteArticle?: (id: string) => void;
  onBoost?: (id: string) => void;
};

type CardProps<C> = {
  idea: BoardIdea;
  concept: C;
  ctx: IdeaCardContext;
  handlers: IdeaCardHandlers;
  busy?: string | null;
  isNew?: boolean;
};

const SOURCE_ICON: Record<IdeaSource, LucideIcon> = {
  trend: TrendingUp,
  season: CalendarDays,
  results: ThumbsUp,
  brand: Gem,
  chat: MessageSquare,
  opportunity: Lightbulb,
  search: Search,
  manual: PenLine,
};

const SOCIAL_BRANDS = new Set<BrandKey>([
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
]);

const EMPTY_KIT = buildBrandKit({
  legacyColors: [],
  fonts: [],
  logoAssetId: null,
  darkLogoAssetId: null,
  identity: null,
});

function dayLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function whenLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function initialOf(name: string): string {
  return (
    name
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .charAt(0)
      .toUpperCase() || "•"
  );
}

function inPool(idea: BoardIdea, now: Date): boolean {
  return ["fresh", "saved", "expired"].includes(boardStatusOf(idea, now));
}

// The post, as it will be made: the layout the post gets, at its format's
// real shape, with the words on the picture.
export function IdeaPostPreview({
  concept,
  kit,
  formatKey,
  fontFamily,
  className,
}: {
  concept: SocialIdeaConcept;
  kit: BrandKit | null;
  formatKey?: string;
  fontFamily?: string;
  className?: string;
}) {
  const brandKit = kit ?? EMPTY_KIT;
  const format = previewFormatOf(
    formatKey ??
      concept.draft.formatKey ??
      `${concept.draft.channels[0] ?? "instagram"}.post`,
  );
  const layout = ideaLayoutOf(brandKit, concept.draft.layoutId, format.aspect);
  const logos = previewLogosOf(brandKit);
  return (
    <LayoutPreview
      layout={layout}
      colors={kitLayoutPalette(brandKit)}
      logos={logos}
      aspect={format.aspect}
      ratio={format.ratio}
      text={{
        headline: concept.draft.headline,
        ...(concept.draft.highlight
          ? { highlight: concept.draft.highlight }
          : {}),
      }}
      fontFamily={fontFamily}
      showLogo={Boolean(logos.light || logos.dark)}
      className={cn("rounded-none ring-0", className)}
    />
  );
}

function ChannelIcons({ channels }: { channels: readonly string[] }) {
  return (
    <span className="flex items-center gap-1">
      {channels
        .filter((channel): channel is BrandKey =>
          SOCIAL_BRANDS.has(channel as BrandKey),
        )
        .map((channel) => (
          <BrandIcon key={channel} brand={channel} className="size-3.5" />
        ))}
    </span>
  );
}

function CardShell({
  idea,
  isNew,
  children,
}: {
  idea: BoardIdea;
  isNew?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article
      data-idea-card={idea.id}
      data-module={idea.concept?.module ?? "untyped"}
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-2xl border transition-shadow hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.25)]",
        isNew && "animate-in fade-in slide-in-from-bottom-2 duration-500",
      )}
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      {isNew ? (
        <span
          className="absolute top-2.5 right-2.5 z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {COPY.newBadge}
        </span>
      ) : null}
      {children}
    </article>
  );
}

// The part of a card that opens the idea's detail (the picture and the
// words): one keyboard-reachable target holding no other control.
function OpenArea({
  id,
  label,
  onOpen,
  children,
}: {
  id: string;
  label: string;
  onOpen?: (id: string) => void;
  children: React.ReactNode;
}) {
  if (!onOpen) return <div className="flex flex-col">{children}</div>;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className="flex cursor-pointer flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onOpen(id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(id);
        }
      }}
    >
      {children}
    </div>
  );
}

function AccountHeader({
  ctx,
  sub,
}: {
  ctx: IdeaCardContext;
  sub: React.ReactNode;
}) {
  const name = ctx.handle ?? (ctx.brandName || COPY.title);
  return (
    <header className="flex items-center gap-2 px-3 py-2.5">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
        style={{ background: "var(--ws-accent)", color: "var(--ws-on-accent)" }}
      >
        {initialOf(ctx.brandName || name)}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[12.5px] leading-tight font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {name}
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px] leading-tight"
          style={{ color: "var(--ws-text-3)" }}
        >
          {sub}
        </span>
      </span>
    </header>
  );
}

function SourceLine({ idea, timezone }: { idea: BoardIdea; timezone: string }) {
  const concept = idea.concept;
  if (!concept) return null;
  const Icon = SOURCE_ICON[concept.source];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{ background: "var(--ws-surface-2)", color: "var(--ws-text-2)" }}
      >
        <Icon aria-hidden className="size-3" />
        {COPY.source[concept.source]}
      </span>
      {strengthOf(concept) === 3 ? (
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: "var(--ws-surface-2)", color: "var(--ws-text)" }}
        >
          <Sparkles aria-hidden className="size-3" />
          {COPY.strong}
        </span>
      ) : null}
      {concept.expiresAt ? (
        <span
          className="inline-flex items-center gap-1 text-[11px]"
          style={{ color: "var(--ws-text-3)" }}
        >
          <Clock aria-hidden className="size-3" />
          {COPY.until(dayLabel(concept.expiresAt, timezone))}
        </span>
      ) : null}
    </div>
  );
}

// Where the idea went: its post's chat, its slot, or published.
function LinkLine({ idea, timezone }: { idea: BoardIdea; timezone: string }) {
  const link = idea.link;
  if (!link) return null;
  const label = link.published
    ? COPY.published
    : link.scheduledFor
      ? COPY.plannedFor(whenLabel(link.scheduledFor, timezone))
      : link.workId
        ? COPY.draftInChat
        : null;
  if (!label) return null;
  return (
    <WsStatusPill
      label={label}
      tone={link.published || link.scheduledFor ? "positive" : "waiting"}
    />
  );
}

function MoreMenu({
  idea,
  handlers,
  now,
}: {
  idea: BoardIdea;
  handlers: IdeaCardHandlers;
  now: Date;
}) {
  const pool = inPool(idea, now);
  const archivable = idea.status !== "ARCHIVED" && idea.status !== "REJECTED";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={COPY.more}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ color: "var(--ws-text-2)" }}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {idea.concept && handlers.onAngle ? (
          <DropdownMenuItem onClick={() => handlers.onAngle?.(idea.id)}>
            {COPY.angle}
          </DropdownMenuItem>
        ) : null}
        {pool && handlers.onPlanInChat ? (
          <DropdownMenuItem onClick={() => handlers.onPlanInChat?.(idea.id)}>
            {COPY.planInChat}
          </DropdownMenuItem>
        ) : null}
        {pool && handlers.onDismiss ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{COPY.notForUs}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              {DISMISS_REASONS.map((reason) => (
                <DropdownMenuItem
                  key={reason}
                  onClick={() => handlers.onDismiss?.(idea.id, reason)}
                >
                  {COPY.reasons[reason]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {handlers.onArchive && archivable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handlers.onArchive?.(idea.id)}>
              {COPY.archive}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionRow({
  idea,
  handlers,
  busy,
  now,
  primary,
}: {
  idea: BoardIdea;
  handlers: IdeaCardHandlers;
  busy?: string | null;
  now: Date;
  primary: React.ReactNode;
}) {
  const saved = idea.status === "APPROVED";
  return (
    <div className="mt-auto flex items-center gap-1.5 px-3 pt-1 pb-3">
      {primary}
      {inPool(idea, now) && handlers.onSave ? (
        <button
          type="button"
          aria-pressed={saved}
          disabled={busy === "save"}
          onClick={() => handlers.onSave?.(idea.id, !saved)}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
          style={{ color: saved ? "var(--ws-text)" : "var(--ws-text-2)" }}
        >
          <Star
            aria-hidden
            className={cn("size-3.5", saved && "fill-current")}
          />
          {saved ? COPY.saved : COPY.save}
        </button>
      ) : null}
      <span className="ml-auto" />
      <MoreMenu idea={idea} handlers={handlers} now={now} />
    </div>
  );
}

function SocialCard({
  idea,
  concept,
  ctx,
  handlers,
  busy,
  isNew,
}: CardProps<SocialIdeaConcept>) {
  const formatKey =
    concept.draft.formatKey ?? `${concept.draft.channels[0]}.post`;
  const status = boardStatusOf(idea, ctx.now);
  const canMake = status === "fresh" || status === "saved";
  const openDraft = Boolean(idea.link?.workId && !idea.link.scheduledFor);
  return (
    <CardShell idea={idea} isNew={isNew}>
      <AccountHeader
        ctx={ctx}
        sub={
          <>
            <ChannelIcons channels={concept.draft.channels} />
            {FORMAT_CHIP[formatKey] ?? FORMAT_CHIP["instagram.post"]}
            {concept.draft.pillar ? ` · ${concept.draft.pillar}` : ""}
          </>
        }
      />
      <OpenArea
        id={idea.id}
        label={concept.draft.hook}
        onOpen={handlers.onOpen}
      >
        <IdeaPostPreview
          concept={concept}
          kit={ctx.kit}
          fontFamily={ctx.fontFamily}
        />
        <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-2">
          <p
            className="line-clamp-2 text-[13.5px] leading-snug font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {concept.draft.hook}
          </p>
          <p
            className="line-clamp-3 text-[12.5px] leading-snug"
            style={{ color: "var(--ws-text-2)" }}
          >
            {concept.draft.caption}
          </p>
          <p
            className="flex items-start gap-1.5 text-[11.5px] leading-snug"
            style={{ color: "var(--ws-text-3)" }}
          >
            <Camera aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-1">{concept.draft.visual}</span>
          </p>
          <SourceLine idea={idea} timezone={ctx.timezone} />
          {concept.why ? (
            <p
              className="line-clamp-2 text-[11.5px] leading-snug"
              style={{ color: "var(--ws-text-3)" }}
            >
              {concept.why}
            </p>
          ) : null}
          <LinkLine idea={idea} timezone={ctx.timezone} />
        </div>
      </OpenArea>
      <ActionRow
        idea={idea}
        handlers={handlers}
        busy={busy}
        now={ctx.now}
        primary={
          canMake && handlers.onMake ? (
            <Button
              size="sm"
              disabled={busy === "make"}
              onClick={() => handlers.onMake?.(idea.id)}
            >
              {busy === "make" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {busy === "make"
                ? COPY.making
                : openDraft
                  ? COPY.openDraft
                  : COPY.make}
            </Button>
          ) : null
        }
      />
    </CardShell>
  );
}

function ArticleCard({
  idea,
  concept,
  ctx,
  handlers,
  busy,
  isNew,
}: CardProps<SeoIdeaConcept>) {
  return (
    <CardShell idea={idea} isNew={isNew}>
      <OpenArea
        id={idea.id}
        label={concept.draft.title}
        onOpen={handlers.onOpen}
      >
        <div
          className="m-3 rounded-xl border p-3.5"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-bg)",
          }}
        >
          <p
            className="flex items-center gap-2 text-[11.5px]"
            style={{ color: "var(--ws-text-2)" }}
          >
            <span
              aria-hidden
              className="flex size-5 items-center justify-center rounded-full text-[10px] font-semibold"
              style={{
                background: "var(--ws-surface-2)",
                color: "var(--ws-text)",
              }}
            >
              {initialOf(ctx.brandName)}
            </span>
            {ctx.brandName}
          </p>
          <p className="mt-1.5 line-clamp-2 text-[15px] leading-snug font-medium text-[#1a0dab] dark:text-[#8ab4f8]">
            {concept.draft.title}
          </p>
          <p
            className="mt-1 line-clamp-3 text-[12.5px] leading-snug"
            style={{ color: "var(--ws-text-2)" }}
          >
            {concept.draft.description}
          </p>
        </div>
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          <p
            className="text-[12px] font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {COPY.articleFor(concept.draft.keyword)}
          </p>
          <p
            className="line-clamp-2 text-[12px] leading-snug"
            style={{ color: "var(--ws-text-2)" }}
          >
            {concept.draft.angle}
          </p>
          <SourceLine idea={idea} timezone={ctx.timezone} />
        </div>
      </OpenArea>
      <ActionRow
        idea={idea}
        handlers={handlers}
        busy={busy}
        now={ctx.now}
        primary={
          handlers.onWriteArticle && inPool(idea, ctx.now) ? (
            <Button
              size="sm"
              onClick={() => handlers.onWriteArticle?.(idea.id)}
            >
              {COPY.writeArticle}
            </Button>
          ) : null
        }
      />
    </CardShell>
  );
}

function AdCard({
  idea,
  concept,
  ctx,
  handlers,
  busy,
  isNew,
}: CardProps<AdIdeaConcept>) {
  return (
    <CardShell idea={idea} isNew={isNew}>
      <AccountHeader ctx={ctx} sub={COPY.sponsored} />
      <OpenArea
        id={idea.id}
        label={concept.draft.angle}
        onOpen={handlers.onOpen}
      >
        {concept.draft.assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the post's own stored picture
          <img
            src={assetUrl(concept.draft.assetId, "card")}
            alt=""
            className="aspect-[4/5] w-full object-cover"
          />
        ) : (
          <div
            className="aspect-[4/5] w-full"
            style={{ background: "var(--ws-surface-2)" }}
          />
        )}
        <div
          className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold"
          style={{ background: "var(--ws-surface-2)", color: "var(--ws-text)" }}
        >
          {COPY.learnMore}
          <span aria-hidden>›</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-2">
          <p
            className="line-clamp-2 text-[13px] leading-snug"
            style={{ color: "var(--ws-text)" }}
          >
            {concept.draft.angle}
          </p>
          <SourceLine idea={idea} timezone={ctx.timezone} />
        </div>
      </OpenArea>
      <ActionRow
        idea={idea}
        handlers={handlers}
        busy={busy}
        now={ctx.now}
        primary={
          handlers.onBoost && inPool(idea, ctx.now) ? (
            <Button size="sm" onClick={() => handlers.onBoost?.(idea.id)}>
              {COPY.boost}
            </Button>
          ) : null
        }
      />
    </CardShell>
  );
}

function OlderCard({
  idea,
  ctx,
  handlers,
  busy,
}: {
  idea: BoardIdea;
  ctx: IdeaCardContext;
  handlers: IdeaCardHandlers;
  busy?: string | null;
}) {
  return (
    <CardShell idea={idea}>
      <OpenArea id={idea.id} label={idea.title} onOpen={handlers.onOpen}>
        <div className="flex flex-col gap-2 px-3.5 pt-3.5 pb-2">
          <span
            className="w-fit rounded-full px-2 py-0.5 text-[10.5px] font-medium"
            style={{
              background: "var(--ws-surface-2)",
              color: "var(--ws-text-2)",
            }}
          >
            {COPY.olderIdea}
          </span>
          <p
            className="line-clamp-3 text-[14px] leading-snug font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {idea.title}
          </p>
          <p
            className="line-clamp-4 text-[12.5px] leading-snug"
            style={{ color: "var(--ws-text-2)" }}
          >
            {idea.description}
          </p>
          <LinkLine idea={idea} timezone={ctx.timezone} />
        </div>
      </OpenArea>
      <ActionRow
        idea={idea}
        handlers={handlers}
        busy={busy}
        now={ctx.now}
        primary={
          inPool(idea, ctx.now) && handlers.onConvert ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "convert"}
              onClick={() => handlers.onConvert?.(idea.id)}
            >
              {busy === "convert" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {COPY.convert}
            </Button>
          ) : null
        }
      />
    </CardShell>
  );
}

export function IdeaCardView({
  idea,
  ctx,
  handlers = {},
  busy,
  isNew,
}: {
  idea: BoardIdea;
  ctx: IdeaCardContext;
  handlers?: IdeaCardHandlers;
  busy?: string | null;
  isNew?: boolean;
}) {
  const concept = idea.concept;
  switch (concept?.module) {
    case "social":
      return (
        <SocialCard
          idea={idea}
          concept={concept}
          ctx={ctx}
          handlers={handlers}
          busy={busy}
          isNew={isNew}
        />
      );
    case "seo":
      return (
        <ArticleCard
          idea={idea}
          concept={concept}
          ctx={ctx}
          handlers={handlers}
          busy={busy}
          isNew={isNew}
        />
      );
    case "ads":
      return (
        <AdCard
          idea={idea}
          concept={concept}
          ctx={ctx}
          handlers={handlers}
          busy={busy}
          isNew={isNew}
        />
      );
    default:
      return (
        <OlderCard idea={idea} ctx={ctx} handlers={handlers} busy={busy} />
      );
  }
}

// A card-sized placeholder while ideas are being found.
export function IdeaCardSkeleton() {
  return (
    <div
      aria-hidden
      data-idea-skeleton
      className="flex flex-col overflow-hidden rounded-2xl border"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          className="size-7 animate-pulse rounded-full"
          style={{ background: "var(--ws-surface-2)" }}
        />
        <span
          className="h-3 w-24 animate-pulse rounded"
          style={{ background: "var(--ws-surface-2)" }}
        />
      </div>
      <div
        className="aspect-[3/4] w-full animate-pulse"
        style={{ background: "var(--ws-surface-2)" }}
      />
      <div className="flex flex-col gap-2 p-3">
        <span
          className="h-3.5 w-11/12 animate-pulse rounded"
          style={{ background: "var(--ws-surface-2)" }}
        />
        <span
          className="h-3 w-3/4 animate-pulse rounded"
          style={{ background: "var(--ws-surface-2)" }}
        />
      </div>
    </div>
  );
}
