"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Compass, Loader2, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";

// A faithful recreation of the real product's idea chat, telling the SAME
// case as ProactiveAi's EVENTS timeline right above it on the page — a
// competitor's landing page triggers work with no one prompting it — but
// as the actual thread the work happens in, instead of a timeline. No
// message ever starts as a user bubble: system/pipeline notes and cards
// open and carry the whole thread, matching how the main app renders a
// SYSTEM-source turn (bkz. src/components/commands/project-chat.tsx —
// "kullanıcı mesajı yoktur, yalnızca asistan balonu"). Card anatomy and
// bubble styles taken from src/components/assistant-ui/thread.tsx and
// src/components/commands/idea-event-card.tsx. Rendered inside the same
// browser frame as AppKanbanShowcase, playing itself out on a timer, then
// looping.

// Department colors — same exact OKLCH values used in AppKanbanShowcase
// (taken from the main app's globals.css, light mode). Duplicated locally
// because the marketing app can't import the main app's src/lib/labels.
const DEPT_COLORS = {
  creative: "oklch(0.55 0.2 346)",
  growth: "oklch(0.5 0.14 145)",
} as const;

// Status badge tones — same set as AppKanbanShowcase's TONE_STYLES.
const TONE_STYLES = {
  waiting:
    "bg-[oklch(0.685_0.16_63)]/15 text-[oklch(0.685_0.16_63)] ring-1 ring-[oklch(0.685_0.16_63)]/25",
  active:
    "bg-[oklch(0.19_0.014_260)]/12 text-[oklch(0.19_0.014_260)] ring-1 ring-[oklch(0.19_0.014_260)]/25",
  positive:
    "bg-[oklch(0.6_0.135_155)]/15 text-[oklch(0.6_0.135_155)] ring-1 ring-[oklch(0.6_0.135_155)]/25",
} as const;

const ICON_TONE_STYLES = {
  waiting: "bg-[oklch(0.685_0.16_63)]/12 text-[oklch(0.685_0.16_63)]",
  active: "bg-[oklch(0.19_0.014_260)]/10 text-[oklch(0.19_0.014_260)]",
  positive: "bg-[oklch(0.6_0.135_155)]/12 text-[oklch(0.6_0.135_155)]",
} as const;

type Tone = keyof typeof TONE_STYLES;
type Dept = keyof typeof DEPT_COLORS;
type CardKind = "task" | "approval";

type ChatItem =
  | { id: string; kind: "note"; text: string; dept?: Dept; deptLabel?: string }
  | {
      id: string;
      kind: "card";
      cardKind: CardKind;
      title: string;
      status: string;
      tone: Tone;
      dept?: Dept;
      deptLabel?: string;
    };

type Step =
  | { op: "add"; item: ChatItem }
  | { op: "update"; id: string; status: string; tone: Tone };

// The conversation script — same case as ProactiveAi's EVENTS ("competitor
// launches a new landing page" → research → opportunity → Creative/SEO
// respond → approval requested), told as the thread it actually happens
// in. "update" steps mutate an already-added card in place (same id)
// rather than appending a new row, exactly like AppKanbanShowcase's
// LIVE_TICKS mutate existing board cards.
const STEPS: Step[] = [
  {
    op: "add",
    item: {
      id: "n1",
      kind: "note",
      text: "Signal detected — a competitor launched a new landing page.",
    },
  },
  {
    op: "add",
    item: {
      id: "t1",
      kind: "card",
      cardKind: "task",
      title: "Positioning & demand scan",
      status: "Running",
      tone: "active",
      dept: "growth",
      deptLabel: "SEO",
    },
  },
  { op: "update", id: "t1", status: "Completed", tone: "positive" },
  {
    op: "add",
    item: {
      id: "n2",
      kind: "note",
      text: "Related demand is up 28% — opportunity created, routing to the team.",
    },
  },
  {
    op: "add",
    item: {
      id: "t2",
      kind: "card",
      cardKind: "task",
      title: "Response concept",
      status: "Running",
      tone: "active",
      dept: "creative",
      deptLabel: "Creative",
    },
  },
  { op: "update", id: "t2", status: "Completed", tone: "positive" },
  {
    op: "add",
    item: {
      id: "ap1",
      kind: "card",
      cardKind: "approval",
      title: "Response campaign — needs your approval",
      status: "Waiting",
      tone: "waiting",
      dept: "creative",
      deptLabel: "Creative",
    },
  },
  { op: "update", id: "ap1", status: "Approved", tone: "positive" },
  {
    op: "add",
    item: {
      id: "n3",
      kind: "note",
      text: "Approved — publishing this week.",
      dept: "creative",
      deptLabel: "Creative",
    },
  },
];

const PAUSE_TICKS = 3;
const TICK_MS = 1900;

function buildTimeline(count: number): ChatItem[] {
  const applied = STEPS.slice(0, count);
  const order: string[] = [];
  const byId = new Map<string, ChatItem>();
  for (const step of applied) {
    if (step.op === "add") {
      order.push(step.item.id);
      byId.set(step.item.id, step.item);
    } else {
      const existing = byId.get(step.id);
      if (existing && existing.kind === "card") {
        byId.set(step.id, {
          ...existing,
          status: step.status,
          tone: step.tone,
        });
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

function DeptPill({ dept, label }: { dept: Dept; label: string }) {
  return (
    <span
      className="inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase"
      style={{ backgroundColor: DEPT_COLORS[dept] }}
    >
      {label}
    </span>
  );
}

const CARD_ICON: Record<CardKind, typeof ShieldCheck> = {
  task: Loader2,
  approval: ShieldCheck,
};

function EventCardView({
  item,
}: {
  item: Extract<ChatItem, { kind: "card" }>;
}) {
  const resolved = item.tone === "positive";
  const Icon =
    item.cardKind === "task" && !resolved ? Loader2 : CARD_ICON[item.cardKind];
  return (
    <div className="ml-0 w-fit max-w-[85%] space-y-2 rounded-2xl bg-white p-3 shadow-xs ring-1 ring-black/8 sm:max-w-sm">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-lg",
            ICON_TONE_STYLES[item.tone],
          )}
        >
          <Icon
            className={cn("size-3.5", Icon === Loader2 && "animate-spin")}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[#1b1b1b]">
            {item.title}
          </p>
          {item.dept && item.deptLabel ? (
            <div className="mt-1">
              <DeptPill dept={item.dept} label={item.deptLabel} />
            </div>
          ) : null}
        </div>
        <span
          key={item.status}
          className={cn(
            "animate-in fade-in inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium duration-500",
            TONE_STYLES[item.tone],
          )}
        >
          {item.status}
        </span>
      </div>
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === "note") {
    return (
      <div
        className="border-l-2 pl-2.5 text-[13px] leading-relaxed text-[#1b1b1b]"
        style={{
          borderLeftColor: item.dept ? DEPT_COLORS[item.dept] : "transparent",
        }}
      >
        <p>{item.text}</p>
        {item.dept && item.deptLabel ? (
          <div className="mt-1.5">
            <DeptPill dept={item.dept} label={item.deptLabel} />
          </div>
        ) : null}
      </div>
    );
  }
  return <EventCardView item={item} />;
}

export function AppChatShowcase() {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Starts mid-conversation (not an empty frame) so first paint — before
  // hydration/JS runs — already reads as a live thread, same as
  // AppKanbanShowcase's always-populated base board.
  const [tick, setTick] = useState(4);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setReduceMotion(reduce);
    if (reduce) {
      setTick(STEPS.length);
      return;
    }
    const id = window.setInterval(() => {
      setTick((t) => (t + 1) % (STEPS.length + PAUSE_TICKS));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [tick, reduceMotion]);

  const visibleCount = Math.min(tick, STEPS.length);
  const items = buildTimeline(visibleCount);
  const isWorking = visibleCount > 0 && visibleCount < STEPS.length;

  return (
    <div className="agentelse-container-wide pb-14 md:pb-20">
      {/* Browser frame */}
      <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_24px_60px_-24px_rgba(0,0,0,0.18)]">
        {/* Browser chrome bar */}
        <div className="flex items-center gap-3 border-b border-border bg-[#fafafa] px-4 py-2.5">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
            <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
            <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
          </div>
          <div className="flex h-7 flex-1 items-center justify-center rounded-md bg-white ring-1 ring-black/8">
            <span className="font-mono text-[11px] text-[#999]">
              app.agentelse.ai
            </span>
          </div>
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[oklch(0.6_0.135_155)]">
            <span className="agentelse-live-dot size-1.5 rounded-full bg-current" />
            Autonomous
          </span>
        </div>

        {/* App bar inside the "product" */}
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs text-[#666]">
            <span className="font-semibold text-[#1b1b1b]">Idea chat</span>
            <span aria-hidden="true">·</span>
            <span>Competitor response</span>
          </div>
          <span className="text-[11px] text-[#999]">
            {isWorking ? "Working…" : "Live"}
          </span>
        </div>

        {/* Chat viewport */}
        <div
          ref={viewportRef}
          className="h-[380px] overflow-y-auto bg-[#fafafa] p-4 sm:h-[420px]"
        >
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <ChatItemView key={item.id} item={item} />
            ))}
            {isWorking ? (
              <span
                aria-hidden="true"
                className="animate-pulse pl-0.5 font-sans text-sm text-[#999]"
              >
                {"●"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        The real product: no one typed a prompt here — the signal opened the
        thread, and only the approval needed you.
      </p>
    </div>
  );
}
