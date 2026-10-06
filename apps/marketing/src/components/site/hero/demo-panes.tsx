import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  BrandAvatar,
  DEMO_BRAND,
  Pill,
  PlatformIcon,
  PostArt,
} from "@/components/site/mock/parts";
import {
  FEATURED,
  POSTS,
  T,
  easeOut,
  postProgress,
  postStatus,
  progress,
} from "@/components/site/hero/timeline";

// The right side of the demo window, one pane per moment of the story. Each
// is a pure picture of the clock position `pos`.

function PaneHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
      <p className="text-[13px] font-semibold tracking-tight">{title}</p>
      {sub ? (
        <span className="text-[11px] text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  );
}

function compact(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}K`
    : `${Math.round(value)}`;
}

// ---- Brand ------------------------------------------------------------------

export function BrandPane({ pos }: { pos: number }) {
  const grow = easeOut(progress(pos, T.countFrom, T.countTo));
  const reach = 18240 + (19810 - 18240) * grow;
  const views = 41730 + (45120 - 41730) * grow;
  const engagement = 5.8 + (6.4 - 5.8) * grow;
  const fresh = pos >= T.published;

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title="Brand" sub={DEMO_BRAND.name} />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 pb-4">
        <div className="flex items-center gap-1.5">
          {(["instagram", "facebook"] as const).map((platform) => (
            <span
              key={platform}
              className="relative flex size-8 items-center justify-center rounded-xl border border-border bg-background"
            >
              <PlatformIcon platform={platform} colored className="size-4" />
              <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-success" />
            </span>
          ))}
          <span className="flex size-8 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground">
            <Plus className="size-3.5" />
          </span>
        </div>

        <div className="rounded-2xl border border-border bg-background p-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            Brand kit
          </p>
          <div className="mt-2 flex items-center gap-2.5">
            <BrandAvatar className="size-9 rounded-xl text-[14px]" />
            <div className="flex gap-1">
              {DEMO_BRAND.colors.map((color) => (
                <span
                  key={color}
                  className="size-5 rounded-md border border-black/5"
                  style={{ background: color }}
                />
              ))}
            </div>
            <span className="ml-auto font-serif text-[18px] leading-none">
              Aa
            </span>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-background p-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <PlatformIcon platform="instagram" className="size-3" />
              Last 28 days
            </p>
            {grow > 0 ? (
              <span className="animate-in fade-in rounded-full bg-[oklch(0.96_0.04_152)] px-1.5 text-[10px] font-medium text-[oklch(0.45_0.12_152)] duration-500">
                +8.6%
              </span>
            ) : null}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {[
              { label: "Reach", value: compact(reach) },
              { label: "Views", value: compact(views) },
              { label: "Engagement", value: `${engagement.toFixed(1)}%` },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg bg-secondary px-2 py-1.5"
              >
                <p className="text-[9.5px] text-muted-foreground">
                  {stat.label}
                </p>
                <p className="text-[14px] font-semibold tracking-tight tabular-nums">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {fresh ? (
              <div className="relative">
                <PostArt
                  headline={POSTS[FEATURED].title}
                  tone={POSTS[FEATURED].tone}
                  className="rounded-md text-[7px]"
                />
                <span className="absolute top-1 left-1 rounded-full bg-background/90 px-1 text-[8px] font-semibold">
                  New
                </span>
              </div>
            ) : (
              <PostArt
                headline="Slow mornings"
                tone="cream"
                className="rounded-md text-[7px]"
              />
            )}
            <PostArt
              headline="Single origin"
              tone="dark"
              className="rounded-md text-[7px]"
            />
            <PostArt
              headline="Oat, always"
              tone="sage"
              className="rounded-md text-[7px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Plan -------------------------------------------------------------------

const PLAN_STEPS = ["Plan", "Content", "Approve & publish"] as const;

export function PlanPane({ pos }: { pos: number }) {
  const prepared = pos >= T.prepare;
  const activeStep = prepared ? 1 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-1 border-b border-border px-4 pt-4 pb-3">
        <p className="text-[11px] font-medium text-muted-foreground">
          Content plan
        </p>
        <p className="text-[14px] font-semibold tracking-tight">
          One plan. Every channel.
        </p>
        <ol className="mt-2 flex items-center gap-1">
          {PLAN_STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-1">
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap transition-colors duration-500",
                  index < activeStep && "text-foreground",
                  index === activeStep && "bg-primary text-primary-foreground",
                  index > activeStep && "text-muted-foreground",
                )}
              >
                {index < activeStep ? <Check className="size-3" /> : null}
                {step}
              </span>
              {index < PLAN_STEPS.length - 1 ? (
                <span className="h-px w-2 bg-border" />
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
        {(["instagram", "facebook"] as const).map((platform) => (
          <span
            key={platform}
            className="inline-flex items-center gap-1.5 rounded-full border border-foreground/15 bg-background px-2 py-0.5 text-[10.5px] font-medium"
          >
            <Check className="size-2.5" />
            <PlatformIcon platform={platform} colored className="size-3" />
            {platform === "instagram" ? "Instagram" : "Facebook"}
            {platform === "instagram" ? (
              <span className="rounded-full bg-secondary px-1 text-[9px] text-muted-foreground">
                + Story
              </span>
            ) : null}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
          <PlatformIcon platform="linkedin" className="size-3" />
          LinkedIn
        </span>
      </div>

      <ul className="flex flex-1 flex-col gap-2 overflow-hidden px-3 py-3">
        {POSTS.map((post, index) => {
          if (pos < T.planRowsFrom + index * 260) return null;
          const status = postStatus(index, pos);
          return (
            <li
              key={post.title}
              className="animate-in fade-in slide-in-from-bottom-2 rounded-xl border border-border bg-background p-2.5 duration-500"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] text-muted-foreground">
                  {post.day} {post.date} · {post.time}
                </span>
                <Pill tone={status.tone} dot={status.live}>
                  {status.label}
                </Pill>
              </div>
              <p className="mt-1 text-[12px] leading-snug font-medium">
                {post.title}
              </p>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1">
                  <PlatformIcon platform="instagram" className="size-3" />
                  {index < 2 ? (
                    <PlatformIcon platform="facebook" className="size-3" />
                  ) : null}
                </span>
                {index === 2 && !prepared ? (
                  <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-foreground">
                    <RefreshCw className="size-2.5" />
                    New idea
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-background px-4 py-2.5">
        <span className="text-[10.5px] text-muted-foreground">
          3 posts · 2 channels
        </span>
        <span
          data-demo-target="prepare"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium transition-colors duration-300",
            prepared
              ? "bg-secondary text-foreground"
              : "bg-primary text-primary-foreground",
          )}
        >
          {prepared ? <Loader2 className="size-3 animate-spin" /> : null}
          {prepared ? "Preparing…" : "Prepare content"}
        </span>
      </div>
    </div>
  );
}

// ---- Outputs ------------------------------------------------------------------

export function OutputsPane({ pos }: { pos: number }) {
  const done = POSTS.filter((_, index) => postProgress(index, pos) >= 1).length;

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title="Outputs" sub={`${done} of 3 ready`} />
      <div className="flex gap-1 px-4 pb-3">
        {["All", "In review", "Approved"].map((filter, index) => (
          <span
            key={filter}
            className={cn(
              "rounded-full px-2.5 py-1 text-[10.5px] font-medium",
              index === 0
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {filter}
          </span>
        ))}
      </div>
      <ul className="flex flex-1 flex-col gap-2 overflow-hidden px-3 pb-3">
        {POSTS.map((post, index) => {
          const p = postProgress(index, pos);
          const status = postStatus(index, pos);
          return (
            <li
              key={post.title}
              className="flex items-center gap-3 rounded-xl border border-border bg-background p-2"
            >
              <div className="w-[52px] shrink-0 overflow-hidden rounded-lg">
                {p >= 1 ? (
                  <div className="demo-blur-in">
                    <PostArt
                      headline={post.title}
                      tone={post.tone}
                      className="text-[6.5px]"
                    />
                  </div>
                ) : (
                  <div className="site-shimmer aspect-[4/5]" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-[12px] font-medium">{post.title}</p>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <PlatformIcon platform="instagram" className="size-3" />
                  {index < 2 ? (
                    <PlatformIcon platform="facebook" className="size-3" />
                  ) : null}
                  <span className="text-[10.5px]">
                    · {post.day} {post.time}
                  </span>
                </span>
                {p < 1 ? (
                  <span className="flex items-center gap-2">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-spark transition-[width] duration-100"
                        style={{ width: `${Math.round(p * 100)}%` }}
                      />
                    </span>
                    <span className="text-[10px] font-medium text-spark tabular-nums">
                      {Math.round(p * 100)}%
                    </span>
                  </span>
                ) : null}
              </div>
              {p >= 1 ? (
                <Pill
                  tone={status.tone}
                  className="animate-in fade-in duration-300"
                >
                  {status.label}
                </Pill>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- One post, to approve ---------------------------------------------------

export function PostPane({ pos }: { pos: number }) {
  const post = POSTS[FEATURED];
  const approved = pos >= T.approve;
  const toast = approved && pos < T.toastTo;

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 text-[11px] text-muted-foreground">
        <ChevronLeft className="size-3.5" />
        Outputs
      </div>
      <div className="flex-1 overflow-hidden px-3">
        <article className="mx-auto max-w-[280px] overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-card)]">
          <header className="flex items-center gap-2 px-3 py-2.5">
            <BrandAvatar className="size-6 text-[10px]" />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-semibold">
                {DEMO_BRAND.handle.slice(1)}
              </p>
              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <PlatformIcon platform="instagram" className="size-2.5" />
                Instagram · Thu {post.time}
              </p>
            </div>
            <Pill tone={approved ? "positive" : "waiting"}>
              {approved ? "Approved" : "In review"}
            </Pill>
            <MoreHorizontal className="size-3.5 text-muted-foreground" />
          </header>
          <PostArt
            headline={post.title}
            kicker={post.kicker}
            tone={post.tone}
            className="text-[19px]"
          />
          <div className="flex items-center gap-1.5 px-3 pt-2.5">
            <span
              data-demo-target="approve"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-3 text-[11.5px] font-medium transition-colors duration-300",
                approved
                  ? "bg-[oklch(0.96_0.04_152)] text-[oklch(0.45_0.12_152)]"
                  : "bg-primary text-primary-foreground",
              )}
            >
              <Check className="size-3" />
              {approved ? "Approved" : "Approve"}
            </span>
            <span
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full bg-secondary px-3 text-[11.5px] font-medium transition-opacity duration-300",
                approved && "opacity-40",
              )}
            >
              <PenLine className="size-3" />
              Revise
            </span>
            <span
              className={cn(
                "inline-flex h-7 items-center gap-1 px-2 text-[11.5px] text-muted-foreground transition-opacity duration-300",
                approved && "opacity-40",
              )}
            >
              <X className="size-3" />
              Decline
            </span>
          </div>
          <p className="px-3 pt-2 pb-3 text-[11.5px] leading-relaxed text-foreground/85">
            <span className="font-semibold text-foreground">
              {DEMO_BRAND.handle.slice(1)}
            </span>{" "}
            Five new cups for colder mornings. Thursday from 7:00.
          </p>
        </article>
      </div>
      {toast ? (
        <div className="animate-in fade-in slide-in-from-bottom-3 absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-[11.5px] text-primary-foreground shadow-[var(--shadow-float)] duration-300">
          <Check className="size-3.5 shrink-0 text-[oklch(0.8_0.12_152)]" />
          Approved — it goes out at its planned time
        </div>
      ) : null}
    </div>
  );
}

// ---- Calendar -----------------------------------------------------------------

const WEEK = [
  { day: "Mon", date: 13 },
  { day: "Tue", date: 14 },
  { day: "Wed", date: 15 },
  { day: "Thu", date: 16 },
  { day: "Fri", date: 17 },
  { day: "Sat", date: 18 },
  { day: "Sun", date: 19 },
];

export function CalendarPane({ pos }: { pos: number }) {
  const dropped = pos >= T.drop;
  const published = pos >= T.published;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <p className="text-[13px] font-semibold tracking-tight">Calendar</p>
        <span className="flex items-center gap-1 text-muted-foreground">
          <ChevronLeft className="size-3.5" />
          <span className="text-[11px] text-foreground">Oct 13 – 19</span>
          <ChevronRight className="size-3.5" />
        </span>
      </div>
      <div className="px-4 pb-2.5">
        <span className="flex w-fit rounded-full bg-secondary p-0.5 text-[10.5px] font-medium">
          <span className="rounded-full px-2 py-0.5 text-muted-foreground">
            Month
          </span>
          <span className="rounded-full bg-background px-2 py-0.5 shadow-[var(--shadow-card)]">
            Week
          </span>
          <span className="rounded-full px-2 py-0.5 text-muted-foreground">
            List
          </span>
        </span>
      </div>
      <ul className="flex flex-1 flex-col overflow-hidden px-3 pb-3">
        {WEEK.map(({ day, date }) => {
          const index = POSTS.findIndex((post) => post.date === date);
          const post = index >= 0 ? POSTS[index] : null;
          const isFeatured = index === FEATURED;
          const show = post && (!isFeatured || dropped);
          const status = post ? postStatus(index, pos) : null;
          return (
            <li
              key={day}
              className={cn(
                "flex min-h-[46px] items-center gap-3 border-b border-border/70 px-1 last:border-b-0",
                isFeatured && "rounded-lg bg-spark-soft/60",
              )}
            >
              <span className="flex w-8 shrink-0 flex-col items-center">
                <span className="text-[9.5px] text-muted-foreground uppercase">
                  {day}
                </span>
                <span className="text-[13px] font-semibold tabular-nums">
                  {date}
                </span>
              </span>
              {show && post && status ? (
                <span
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-2 py-1.5",
                    isFeatured
                      ? "demo-drop border-foreground/15"
                      : "border-border",
                  )}
                >
                  <PlatformIcon
                    platform="instagram"
                    colored
                    className="size-3"
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {post.title}
                  </span>
                  {isFeatured && published ? (
                    <span className="animate-in zoom-in-50 fade-in flex size-4 items-center justify-center rounded-full bg-success text-white duration-300">
                      <Check className="size-2.5" />
                    </span>
                  ) : null}
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {post.time}
                  </span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      status.label === "Published" && "bg-success",
                      status.label === "Scheduled" && "bg-primary",
                      status.label === "In review" && "bg-warning",
                      (status.label === "Making…" || status.label === "Idea") &&
                        "bg-spark",
                    )}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-primary" />
          Scheduled
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-success" />
          Published
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-warning" />
          In review
        </span>
      </div>
    </div>
  );
}
