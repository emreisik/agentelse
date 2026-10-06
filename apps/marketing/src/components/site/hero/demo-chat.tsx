import {
  ArrowUp,
  BarChart3,
  CalendarRange,
  Check,
  Heart,
  Lightbulb,
  Loader2,
  MessageCircle,
  Plus,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Pill, PlatformIcon, PostArt } from "@/components/site/mock/parts";
import { Spark } from "@/components/site/section";
import {
  ASK_TEXT,
  FEATURED,
  POSTS,
  REPLY_TEXT,
  T,
  easeOut,
  postStatus,
  progress,
} from "@/components/site/hero/timeline";

const PLACEHOLDER = "Write down what's on your mind. Let's bring it to life…";

// The chat column of the demo: the first screen until the message is sent,
// then the conversation, newest at the bottom, like the product.
export function DemoChat({ pos }: { pos: number }) {
  return pos < T.send ? <FirstScreen pos={pos} /> : <Thread pos={pos} />;
}

function Composer({
  text,
  caret,
  filled,
}: {
  text: string;
  caret: boolean;
  filled: boolean;
}) {
  return (
    <div
      data-demo-target="composer"
      className="flex items-end gap-2 rounded-[18px] border border-border bg-background px-2.5 py-2 shadow-[var(--shadow-card)]"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
        <Plus className="size-4" />
      </span>
      <p className="min-h-7 flex-1 py-1 text-[12.5px] leading-5">
        {text ? (
          <>
            {text}
            {caret ? <span className="demo-caret" /> : null}
          </>
        ) : (
          <span className="text-muted-foreground">
            {caret ? <span className="demo-caret mr-0.5 ml-0" /> : null}
            {PLACEHOLDER}
          </span>
        )}
      </p>
      <span
        data-demo-target="send"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
          filled
            ? "bg-primary text-primary-foreground"
            : "bg-secondary text-muted-foreground",
        )}
      >
        <ArrowUp className="size-3.5" />
      </span>
    </div>
  );
}

function FirstScreen({ pos }: { pos: number }) {
  const typed = ASK_TEXT.slice(
    0,
    Math.round(progress(pos, T.typeFrom, T.typeTo) * ASK_TEXT.length),
  );
  const focused = pos >= T.typeFrom - 100;

  return (
    <div className="flex flex-1 flex-col justify-center px-5 sm:px-10">
      <div className="relative">
        <p className="text-[24px] leading-tight font-medium tracking-[-0.04em] sm:text-[28px]">
          Good evening<span className="text-spark">.</span>
        </p>
        <Spark className="absolute top-0 right-0 hidden size-9 rotate-12 opacity-40 sm:block" />
      </div>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">
        What should we bring to life for your brand today?
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[13px] border border-border bg-muted px-3.5 py-2.5">
        <div>
          <p className="text-[11px] font-medium">Where we left off.</p>
          <p className="text-[10px] text-muted-foreground">Mira Coffee</p>
        </div>
        <div className="ml-auto flex gap-4 text-center">
          {[
            { value: 4, label: "ready drafts" },
            { value: 2, label: "pending approval" },
            { value: 7, label: "approved" },
          ].map((stat) => (
            <div key={stat.label}>
              <p className="text-[13px] font-semibold tabular-nums">
                {stat.value}
              </p>
              <p className="text-[9.5px] text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <Composer text={typed} caret={focused} filled={typed.length > 0} />
      </div>

      <ul className="mt-3 flex flex-col gap-0.5">
        {[
          {
            Icon: CalendarRange,
            text: "Plan the week for Instagram and Facebook",
          },
          { Icon: Lightbulb, text: "Give me content ideas for Mira Coffee" },
          { Icon: BarChart3, text: "How is our performance lately?" },
        ].map(({ Icon, text }) => (
          <li
            key={text}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-foreground/75"
          >
            <Icon className="size-3.5 text-muted-foreground" />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssistantRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-2 flex gap-2.5 duration-500",
        className,
      )}
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
        <Spark className="size-3" />
      </span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground/90">
        {children}
      </div>
    </div>
  );
}

function PlanCard({ pos }: { pos: number }) {
  const pill =
    pos >= T.published
      ? { label: "1 published", tone: "positive" as const }
      : pos >= T.approve
        ? { label: "1 approved", tone: "positive" as const }
        : pos >= T.readyLine
          ? { label: "Ready for review", tone: "waiting" as const }
          : pos >= T.prepare
            ? { label: "Making posts", tone: "live" as const }
            : { label: "Plan", tone: "neutral" as const };

  return (
    <div className="animate-in fade-in zoom-in-95 mt-2.5 overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-card)] duration-500">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-lg bg-secondary">
            <CalendarRange className="size-3" />
          </span>
          <div>
            <p className="text-[12px] font-semibold">Social media plan</p>
            <p className="text-[10px] text-muted-foreground">
              Oct 13 – 19 · 3 posts · 2 channels
            </p>
          </div>
        </div>
        <Pill tone={pill.tone} dot={pill.tone === "live"}>
          {pill.label}
        </Pill>
      </div>
      <ul className="divide-y divide-border">
        {POSTS.map((post, index) => {
          const status = postStatus(index, pos);
          return (
            <li
              key={post.title}
              className="flex items-center gap-2.5 px-3 py-2"
            >
              <span className="w-7 text-[10.5px] font-medium text-muted-foreground">
                {post.day}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px]">
                {post.title}
              </span>
              <Pill tone={status.tone} dot={status.live}>
                {status.label}
              </Pill>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ResultsCard({ pos }: { pos: number }) {
  const count = easeOut(progress(pos, T.countFrom, T.countTo));
  const counted = count >= 1;
  const worked = pos >= T.worked;
  const post = POSTS[FEATURED];

  return (
    <div className="animate-in fade-in zoom-in-95 mt-2.5 overflow-hidden rounded-2xl border border-border bg-background shadow-[var(--shadow-card)] duration-500">
      <div className="flex gap-3 p-3">
        <PostArt
          headline={post.title}
          tone={post.tone}
          className="w-[58px] shrink-0 rounded-lg text-[7px]"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <PlatformIcon platform="instagram" className="size-3" />
            Published · Thu {post.time}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              {
                Icon: Heart,
                label: "Likes",
                value: Math.round(412 * count),
                compare: "1.4×",
              },
              {
                Icon: MessageCircle,
                label: "Comments",
                value: Math.round(57 * count),
                compare: "2.1×",
              },
            ].map(({ Icon, label, value, compare }) => (
              <div key={label} className="rounded-lg bg-secondary px-2 py-1.5">
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Icon className="size-2.5" />
                  {label}
                </p>
                <p className="text-[15px] font-semibold tracking-tight tabular-nums">
                  {value}
                </p>
                <p
                  className={cn(
                    "text-[9.5px] text-success transition-opacity duration-500",
                    counted ? "opacity-100" : "opacity-0",
                  )}
                >
                  {compare} your average
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border bg-muted px-3 py-2">
        <span className="text-[11px] font-medium">Did it work?</span>
        <span className="flex gap-1">
          <span
            data-demo-target="worked"
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors duration-300",
              worked
                ? "bg-primary text-primary-foreground"
                : "bg-background ring-1 ring-border",
            )}
          >
            <ThumbsUp className="size-3" />
            Worked
          </span>
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-background px-2.5 text-[11px] text-muted-foreground ring-1 ring-border">
            <ThumbsDown className="size-3" />
            Didn&apos;t work
          </span>
        </span>
      </div>
    </div>
  );
}

function nextSteps(pos: number): string[] {
  if (pos >= T.worked) return ["Plan the next weeks", "Review 2"];
  if (pos >= T.published) return ["See results (1)", "Review 2"];
  if (pos >= T.approve) return ["Review 2"];
  if (pos >= T.readyLine) return ["Review 3"];
  return [];
}

function Thread({ pos }: { pos: number }) {
  const replyWords = REPLY_TEXT.split(" ");
  const shownWords = Math.round(
    progress(pos, T.replyFrom, T.replyTo) * replyWords.length,
  );
  const steps = nextSteps(pos);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pt-6 [mask-image:linear-gradient(to_bottom,transparent,black_56px)] sm:px-8">
        <div className="animate-in fade-in slide-in-from-bottom-3 flex justify-end duration-500">
          <p className="max-w-[82%] rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-[12.5px] leading-relaxed">
            {ASK_TEXT}
          </p>
        </div>

        {pos >= T.thinking && pos < T.replyFrom ? (
          <AssistantRow>
            <span className="demo-text-shimmer">
              Planning your week…
            </span>
          </AssistantRow>
        ) : null}

        {pos >= T.replyFrom ? (
          <AssistantRow>
            <p>{replyWords.slice(0, Math.max(1, shownWords)).join(" ")}</p>
            {pos >= T.planCard ? <PlanCard pos={pos} /> : null}
          </AssistantRow>
        ) : null}

        {pos >= T.makingLine ? (
          <AssistantRow>
            {pos >= T.readyLine ? (
              <p className="flex items-center gap-1.5">
                <Check className="size-3.5 text-success" />3 posts are ready for
                your review.
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Making 3 posts in your autumn style…
              </p>
            )}
          </AssistantRow>
        ) : null}

        {pos >= T.published + 200 ? (
          <AssistantRow>
            <p className="flex items-center gap-1.5">
              <PlatformIcon platform="instagram" colored className="size-3.5" />
              Published on Instagram · Thu {POSTS[FEATURED].time}
            </p>
          </AssistantRow>
        ) : null}

        {pos >= T.results ? (
          <AssistantRow>
            <p>Here&apos;s how the launch post is doing.</p>
            <ResultsCard pos={pos} />
            {pos >= T.worked + 250 ? (
              <p className="animate-in fade-in mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground duration-500">
                <Spark className="size-3" />
                Noted. Next plans lean on posts like this.
              </p>
            ) : null}
          </AssistantRow>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 px-4 pt-2 pb-4 sm:px-8">
        {steps.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[10.5px] font-medium text-muted-foreground">
              Next step
            </span>
            {steps.map((step, index) => (
              <span
                key={step}
                className={cn(
                  "animate-in fade-in zoom-in-95 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium duration-300",
                  index === 0
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background",
                )}
              >
                {step}
              </span>
            ))}
          </div>
        ) : null}
        <Composer text="" caret={false} filled={false} />
      </div>
    </div>
  );
}
