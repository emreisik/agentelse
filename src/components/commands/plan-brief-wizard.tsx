"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WsEventCard, WsTag } from "@/components/commands/ws-event-card";
import {
  ChannelBadge,
  ConnectionDot,
  FormatGlyphIcon,
} from "@/components/commands/channel-badge";
import { useChatSend } from "@/components/commands/chat-send-context";
import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOALS,
  PLAN_GOAL_LABEL,
  type ChannelKey,
  type PlanGoal,
} from "@/lib/content-channels";
import { addDaysToKey, mondayOf } from "@/lib/content-plan-view";
import {
  MAX_BRIEF_WEEKS,
  serializePlanBrief,
  totalBriefItems,
  type PlanBrief,
} from "@/lib/plan-brief";
import { submitChatMessageAction } from "@/server/actions/command-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type BriefCard = Extract<IdeaEventCardData, { kind: "plan-brief" }>;
type StepKey = "goal" | "channels" | "formats" | "rhythm";

const PER_WEEK_OPTIONS = [3, 5, 7] as const;
const WEEKS_OPTIONS = [1, 2, MAX_BRIEF_WEEKS] as const;
const START_OPTIONS = ["today", "tomorrow", "monday"] as const;
type StartChoice = (typeof START_OPTIONS)[number];

const START_LABEL: Record<StartChoice, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  monday: "Next Monday",
};

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function startDate(choice: StartChoice, today: string): string {
  if (choice === "today") return today;
  if (choice === "tomorrow") return addDaysToKey(today, 1);
  return addDaysToKey(mondayOf(today), 7);
}

const chipStyle = (active: boolean) => ({
  borderColor: active ? "var(--ws-accent)" : "var(--ws-border)",
  background: active ? "var(--ws-accent)" : "transparent",
  color: active ? "var(--ws-on-accent)" : "var(--ws-text-2)",
});

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50"
      style={chipStyle(active)}
    >
      {children}
    </button>
  );
}

// Where the client's plan request gets sharpened: four short steps (goal,
// channels, formats, rhythm — the formats step is skipped when every chosen
// channel has just one format) instead of a chat interview. The answer goes
// back as ONE message (plan-brief.ts) that the agent and the plan validation
// both read, so the plan is exactly what was picked here.
export function PlanBriefWizard({ card }: { card: BriefCard }) {
  const router = useRouter();
  const send = useChatSend();

  const [goal, setGoal] = useState<PlanGoal | null>(null);
  // Connected social channels start ticked with their first format, so the
  // common case is "Next, Next".
  const [picked, setPicked] = useState<Partial<Record<ChannelKey, string[]>>>(
    () =>
      Object.fromEntries(
        CHANNEL_KEYS.filter(
          (key) =>
            CHANNELS[key].group === "social" &&
            card.connections[key]?.connected,
        ).map((key) => [key, [CHANNELS[key].formats[0]!.key]]),
      ),
  );
  const [perWeek, setPerWeek] = useState<(typeof PER_WEEK_OPTIONS)[number]>(3);
  const [weeks, setWeeks] = useState<(typeof WEEKS_OPTIONS)[number]>(2);
  const [startChoice, setStartChoice] = useState<StartChoice>("tomorrow");
  const [theme, setTheme] = useState(card.theme ?? "");
  const [stepIndex, setStepIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<PlanBrief | null>(null);

  const selected = CHANNEL_KEYS.filter((key) => picked[key]);
  const needsFormats = selected.some((key) => CHANNELS[key].formats.length > 1);
  const steps: StepKey[] = [
    "goal",
    "channels",
    ...(needsFormats ? (["formats"] as const) : []),
    "rhythm",
  ];
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const isLast = step === "rhythm";

  const canNext =
    step === "goal"
      ? goal !== null
      : step === "channels"
        ? selected.length > 0
        : step === "formats"
          ? selected.every((key) => (picked[key]?.length ?? 0) > 0)
          : true;

  const total = totalBriefItems({ perWeek, weeks });
  const missingSocial = selected.filter(
    (key) => CHANNELS[key].group !== "seo" && !card.connections[key]?.connected,
  );
  const integrationsHref = `/projects/${card.projectId}/integrations`;

  const toggleChannel = (key: ChannelKey) =>
    setPicked((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = [CHANNELS[key].formats[0]!.key];
      return next;
    });

  const toggleFormat = (channel: ChannelKey, formatKey: string) =>
    setPicked((prev) => {
      const current = prev[channel] ?? [];
      const next = current.includes(formatKey)
        ? current.filter((key) => key !== formatKey)
        : [...current, formatKey];
      return next.length === 0 ? prev : { ...prev, [channel]: next };
    });

  const submit = async () => {
    if (!goal || sending) return;
    const brief: PlanBrief = {
      goal,
      channels: selected.map((channel) => ({
        channel,
        formats: picked[channel]!,
      })),
      perWeek,
      weeks,
      start: startDate(startChoice, card.today),
      theme: theme.trim() || undefined,
    };
    const text = serializePlanBrief(brief);
    setSending(true);
    setSent(brief);
    try {
      if (send) {
        await send(text);
        return;
      }
      const formData = new FormData();
      formData.set("projectId", card.projectId);
      formData.set("text", text);
      if (card.ideaId) formData.set("ideaId", card.ideaId);
      const result = await submitChatMessageAction(formData);
      if (!result.ok) {
        setSent(null);
        toast.error(result.message);
        return;
      }
      router.refresh();
    } catch (error) {
      setSent(null);
      toast.error(
        error instanceof Error ? error.message : "Could not send the brief",
      );
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <WsEventCard icon={CheckCircle2} title="Plan brief sent" tone="positive">
        <div className="flex flex-wrap gap-1.5">
          <WsTag>{PLAN_GOAL_LABEL[sent.goal].label}</WsTag>
          {sent.channels.map(({ channel }) => (
            <WsTag key={channel}>{CHANNELS[channel].label}</WsTag>
          ))}
          <WsTag>
            {sent.perWeek}/week · {sent.weeks} wk
          </WsTag>
        </div>
      </WsEventCard>
    );
  }

  return (
    <div
      className="mt-1 w-full max-w-md space-y-3 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <div className="flex items-center gap-1.5" aria-hidden>
        {steps.map((key, index) => (
          <span
            key={key}
            className="h-1 flex-1 rounded-full"
            style={{
              background:
                index <= stepIndex ? "var(--ws-accent)" : "var(--ws-border)",
            }}
          />
        ))}
      </div>

      {step === "goal" ? (
        <div className="space-y-2">
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            What is this plan for?
          </p>
          <ul className="space-y-1.5">
            {PLAN_GOALS.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => {
                    setGoal(key);
                    setStepIndex(1);
                  }}
                  aria-pressed={goal === key}
                  className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-[var(--ws-hover)]"
                  style={{
                    borderColor:
                      goal === key ? "var(--ws-accent)" : "var(--ws-border)",
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block text-sm font-medium"
                      style={{ color: "var(--ws-text)" }}
                    >
                      {PLAN_GOAL_LABEL[key].label}
                    </span>
                    <span
                      className="block text-xs"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {PLAN_GOAL_LABEL[key].hint}
                    </span>
                  </span>
                  {goal === key ? <Check className="size-4" /> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {step === "channels" ? (
        <div className="space-y-2">
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            Where should it go?
          </p>
          <ul className="grid grid-cols-2 gap-1.5">
            {CHANNEL_KEYS.map((key) => {
              const def = CHANNELS[key];
              const on = Boolean(picked[key]);
              const connection = card.connections[key];
              const state =
                def.group === "seo"
                  ? "manual"
                  : connection?.connected
                    ? "connected"
                    : "missing";
              const status =
                def.group === "seo"
                  ? "You publish"
                  : connection?.connected
                    ? (connection.accountLabel ?? "Connected")
                    : "Not connected";
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => toggleChannel(key)}
                    aria-pressed={on}
                    className="flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors hover:bg-[var(--ws-hover)]"
                    style={{
                      borderColor: on ? "var(--ws-accent)" : "var(--ws-border)",
                    }}
                  >
                    <ChannelBadge channel={key} />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs font-medium"
                        style={{ color: "var(--ws-text)" }}
                      >
                        {def.label}
                      </span>
                      <span
                        className="flex items-center gap-1 text-[11px]"
                        style={{ color: "var(--ws-text-2)" }}
                      >
                        <ConnectionDot state={state} />
                        <span className="truncate">{status}</span>
                      </span>
                    </span>
                    {on ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {missingSocial.length > 0 ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {missingSocial.map((key) => CHANNELS[key].label).join(", ")}{" "}
              {missingSocial.length === 1 ? "isn't" : "aren't"} connected: the
              plan is still drafted, you publish it yourself until you{" "}
              <Link href={integrationsHref} className="underline">
                connect it
              </Link>
              .
            </p>
          ) : null}
        </div>
      ) : null}

      {step === "formats" ? (
        <div className="space-y-2.5">
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            Which formats?
          </p>
          {selected
            .filter((key) => CHANNELS[key].formats.length > 1)
            .map((key) => (
              <div key={key} className="space-y-1.5">
                <span className="flex items-center gap-1.5">
                  <ChannelBadge channel={key} />
                  <span
                    className="text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {CHANNELS[key].label}
                  </span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {CHANNELS[key].formats.map((format) => (
                    <Chip
                      key={format.key}
                      active={picked[key]?.includes(format.key) ?? false}
                      onClick={() => toggleFormat(key, format.key)}
                    >
                      <FormatGlyphIcon glyph={format.glyph} />
                      {format.label}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
        </div>
      ) : null}

      {step === "rhythm" ? (
        <div className="space-y-3">
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            How often, and from when?
          </p>
          <Row label="Pieces per week">
            {PER_WEEK_OPTIONS.map((value) => (
              <Chip
                key={value}
                active={perWeek === value}
                onClick={() => setPerWeek(value)}
              >
                {value}
              </Chip>
            ))}
          </Row>
          <Row label="For">
            {WEEKS_OPTIONS.map((value) => (
              <Chip
                key={value}
                active={weeks === value}
                onClick={() => setWeeks(value)}
              >
                {value} {value === 1 ? "week" : "weeks"}
              </Chip>
            ))}
          </Row>
          <Row label="Starting">
            {START_OPTIONS.map((value) => (
              <Chip
                key={value}
                active={startChoice === value}
                onClick={() => setStartChoice(value)}
              >
                {START_LABEL[value]} ·{" "}
                {formatDate(startDate(value, card.today))}
              </Chip>
            ))}
          </Row>
          <label className="block space-y-1">
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              Theme or focus (optional)
            </span>
            <Input
              value={theme}
              maxLength={200}
              onChange={(event) => setTheme(event.target.value)}
              placeholder="e.g. new service launch"
            />
          </label>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            About {total} pieces
            {total < selected.length
              ? `, fewer than the ${selected.length} channels — some won't get a post. Raise the weekly count to cover them all.`
              : "."}
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(stepIndex === 0 && "invisible")}
          disabled={sending}
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
        >
          Back
        </Button>
        {step !== "goal" ? (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={!canNext || sending}
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
            onClick={() =>
              isLast ? void submit() : setStepIndex((i) => i + 1)
            }
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {isLast ? "Create plan" : "Next"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
