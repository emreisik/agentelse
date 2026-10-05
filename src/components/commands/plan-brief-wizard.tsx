"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CheckCircle2, Loader2, Plus } from "lucide-react";

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
  isPlanGoal,
  type ChannelKey,
  type PlanGoal,
} from "@/lib/content-channels";
import { addDaysToKey, mondayOf } from "@/lib/content-plan-view";
import {
  MAX_BRIEF_PER_WEEK,
  MAX_BRIEF_WEEKS,
  channelsLeftOut,
  serializePlanBrief,
  totalBriefItems,
  type PlanBrief,
  type PlanBriefPrefill,
} from "@/lib/plan-brief";
import { isSocialPlatform } from "@/lib/works/plan-platforms";
import { submitChatMessageAction } from "@/server/actions/command-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type BriefCard = Extract<IdeaEventCardData, { kind: "plan-brief" }>;
type StepKey = "goal" | "channels" | "formats" | "rhythm";
type Picked = Partial<Record<ChannelKey, string[]>>;

const PER_WEEK_OPTIONS = [3, 5, 7] as const;
const WEEKS_OPTIONS = [1, 2, MAX_BRIEF_WEEKS] as const;
const DEFAULT_PER_WEEK = 3;
const DEFAULT_WEEKS = 2;
const START_OPTIONS = ["today", "tomorrow", "monday"] as const;
// "after" only exists when there is a plan to continue (card.continuation).
type StartChoice = (typeof START_OPTIONS)[number] | "after";
// PlanBriefSchema's theme limit.
const THEME_MAX = 200;
const TOPIC_TAG_MAX = 40;

const START_LABEL: Record<StartChoice, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  monday: "Next Monday",
  after: "After your plan",
};

const STORY_LABEL = "Story";
// The plan pane's words for the same switch (plan-pane/copy.ts storyAria).
const STORY_ARIA = "Also share each Instagram post as a Story";

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function startDate(
  choice: StartChoice,
  today: string,
  continueFrom?: string,
): string {
  if (choice === "after" && continueFrom) return continueFrom;
  if (choice === "today") return today;
  if (choice === "tomorrow") return addDaysToKey(today, 1);
  return addDaysToKey(mondayOf(today), 7);
}

// "Instagram", "Instagram and Facebook", "Instagram, Facebook and X".
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max
    ? `${chars.slice(0, max).join("").trimEnd()}…`
    : text;
}

function withinRange(value: number | undefined, max: number): value is number {
  return (
    value !== undefined && Number.isInteger(value) && value >= 1 && value <= max
  );
}

// In a Work with channels, only those are offered.
function offeredChannelsOf(card: BriefCard): readonly ChannelKey[] {
  const own = card.workChannels ?? [];
  return own.length > 0
    ? CHANNEL_KEYS.filter((key) => own.includes(key))
    : CHANNEL_KEYS;
}

export type BriefChoices = {
  goal: PlanGoal | null;
  picked: Picked;
  story: boolean;
  perWeek: number;
  weeks: number;
  theme: string;
};

// What every step starts with. The channels: the ones the client's own words
// name (prefill), else the ones the last plan used (continuation), else the
// Work's, else the chat's default channels (`defaults`, so a project with
// nothing connected still starts on them), else the connected social channels;
// each with the formats the last plan used, else its first format. The rhythm
// and the theme: the prefill's, else the usual 3 a week for 2 weeks and the
// card's theme.
export function initialBriefChoices(
  card: BriefCard,
  prefill: PlanBriefPrefill = {},
  defaults: readonly ChannelKey[] = [],
): BriefChoices {
  const continuation = card.continuation;
  const inherited = (key: ChannelKey): string[] =>
    (continuation?.formats?.[key] ?? []).filter((formatKey) =>
      CHANNELS[key].formats.some((format) => format.key === formatKey),
    );
  const firstFormat = (key: ChannelKey): string[] => [
    CHANNELS[key].formats[0]!.key,
  ];
  const ownOrFirst = (key: ChannelKey): string[] => {
    const own = inherited(key);
    return own.length > 0 ? own : firstFormat(key);
  };
  const pick = (
    keys: readonly ChannelKey[],
    formatsOf: (key: ChannelKey) => string[],
  ): Picked => Object.fromEntries(keys.map((key) => [key, formatsOf(key)]));

  const offered = offeredChannelsOf(card);
  const named = offered.filter((key) => prefill.channels?.includes(key));
  const continued = CHANNEL_KEYS.filter((key) => inherited(key).length > 0);
  const workChannels = card.workChannels ?? [];
  const defaulted = offered.filter((key) => defaults.includes(key));
  const connected = CHANNEL_KEYS.filter(
    (key) =>
      CHANNELS[key].group === "social" && card.connections[key]?.connected,
  );
  const picked =
    named.length > 0
      ? pick(named, ownOrFirst)
      : continued.length > 0
        ? pick(continued, inherited)
        : pick(
            [workChannels, defaulted, connected].find(
              (keys) => keys.length > 0,
            ) ?? [],
            firstFormat,
          );

  const goal = continuation?.goal;
  const topic = prefill.topic?.trim().slice(0, THEME_MAX);
  // The brand's current focus can be longer than a brief takes: a longer
  // theme would make the whole brief unreadable (parsePlanBrief).
  const focus = card.theme?.trim().slice(0, THEME_MAX);
  return {
    goal: isPlanGoal(goal) ? goal : null,
    picked,
    story: prefill.story === true,
    perWeek: withinRange(prefill.perWeek, MAX_BRIEF_PER_WEEK)
      ? prefill.perWeek
      : DEFAULT_PER_WEEK,
    weeks: withinRange(prefill.weeks, MAX_BRIEF_WEEKS)
      ? prefill.weeks
      : DEFAULT_WEEKS,
    theme: topic || focus || "",
  };
}

// A rhythm row's chips: the usual values, plus a prefilled one in its place
// when it is not among them ("4 a week").
export function rhythmChoices(
  usual: readonly number[],
  value: number,
): number[] {
  return usual.includes(value)
    ? [...usual]
    : [...usual, value].sort((a, b) => a - b);
}

// What the client's own words already set, as tags on the first step: the
// steps after it start from these.
export function prefillTags(
  prefill: PlanBriefPrefill | undefined,
  choices: BriefChoices,
): string[] {
  if (!prefill) return [];
  const picked = CHANNEL_KEYS.filter((key) => choices.picked[key]);
  const named = picked.filter((key) => prefill.channels?.includes(key));
  const shown =
    named.length > 0
      ? named
      : choices.story && choices.picked.instagram
        ? (["instagram"] as const)
        : [];
  const tags = shown.map((key) =>
    key === "instagram" && choices.story
      ? `${CHANNELS.instagram.label} + ${STORY_LABEL}`
      : CHANNELS[key].label,
  );
  if (withinRange(prefill.perWeek, MAX_BRIEF_PER_WEEK)) {
    tags.push(`${prefill.perWeek}/week`);
  }
  if (withinRange(prefill.weeks, MAX_BRIEF_WEEKS)) {
    tags.push(`${prefill.weeks} ${prefill.weeks === 1 ? "week" : "weeks"}`);
  }
  const topic = prefill.topic?.trim();
  if (topic) tags.push(`“${clip(topic, TOPIC_TAG_MAX)}”`);
  return tags;
}

// The rhythm step's count line. A post goes to every social channel of the
// brief (docs/works.md "Posts"); Blog/SEO and Ads pieces are not posts, so a
// count below what the slots rotate through leaves those out.
export function coverageLine(
  brief: Pick<PlanBrief, "channels" | "story" | "perWeek" | "weeks">,
): string {
  const total = totalBriefItems(brief);
  const keys = brief.channels.map(({ channel }) => channel);
  const social = keys.filter(isSocialPlatform);
  const story = brief.story === true && social.includes("instagram");
  const where = joinNames(
    social.map((key) =>
      key === "instagram" && story
        ? `${CHANNELS.instagram.label} + ${STORY_LABEL}`
        : CHANNELS[key].label,
    ),
  );
  const spread = social.length > 1 || story;
  const head =
    social.length === keys.length
      ? `About ${total} ${total === 1 ? "post" : "posts"}${spread ? `, each on ${where}` : ""}.`
      : `About ${total} ${total === 1 ? "piece" : "pieces"}.${spread ? ` Each post goes to ${where}.` : ""}`;
  const left = channelsLeftOut(brief);
  if (left.length === 0) return head;
  return `${head} ${joinNames(left.map((key) => CHANNELS[key].label))} won't get one at this count: raise the weekly count to cover ${left.length === 1 ? "it" : "them"}.`;
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

// "+ Story" on the Instagram tile, the plan pane's switch (pane-parts.tsx
// ChannelChips): each Instagram post also goes out as a Story made from its
// picture.
function StoryToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={STORY_ARIA}
      title={STORY_ARIA}
      onClick={onToggle}
      className="mr-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={
        on
          ? {
              background: "var(--ws-text)",
              borderColor: "var(--ws-text)",
              color: "var(--ws-surface)",
            }
          : {
              background: "var(--ws-surface)",
              borderColor: "var(--ws-border)",
              color: "var(--ws-text-2)",
            }
      }
    >
      {on ? (
        <Check aria-hidden className="size-3" strokeWidth={3} />
      ) : (
        <Plus aria-hidden className="size-3" />
      )}
      {STORY_LABEL}
    </button>
  );
}

// Where the client's plan request gets sharpened: four short steps (goal,
// channels, formats, rhythm — the formats step is skipped when no channel has
// a format to choose) instead of a chat interview. The answer goes back as ONE
// message (plan-brief.ts) that the agent and the plan validation both read, so
// the plan is exactly what was picked here. A plan is made of posts and every
// post goes to each chosen social channel (docs/works.md "Posts").
// `prefill`: what is already known (the New Chat module start reads it from the
// client's words). `defaults`: the chat's channels, ticked when neither the
// words nor the last plan name any. Both are read once, when the wizard opens.
export function PlanBriefWizard({
  card,
  prefill,
  defaults,
}: {
  card: BriefCard;
  prefill?: PlanBriefPrefill;
  defaults?: readonly ChannelKey[];
}) {
  const router = useRouter();
  const send = useChatSend();

  const continuation = card.continuation;
  const [initial] = useState(() =>
    initialBriefChoices(card, prefill, defaults),
  );
  const [goal, setGoal] = useState<PlanGoal | null>(initial.goal);
  const [picked, setPicked] = useState<Picked>(initial.picked);
  const [story, setStory] = useState(initial.story);
  const [perWeek, setPerWeek] = useState(initial.perWeek);
  const [weeks, setWeeks] = useState(initial.weeks);
  const startOptions: readonly StartChoice[] = continuation?.continueFrom
    ? ["after", ...START_OPTIONS]
    : START_OPTIONS;
  const [startChoice, setStartChoice] = useState<StartChoice>(
    continuation?.continueFrom ? "after" : "tomorrow",
  );
  const [theme, setTheme] = useState(initial.theme);
  const [stepIndex, setStepIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<PlanBrief | null>(null);

  const offeredChannels = offeredChannelsOf(card);
  const selected = CHANNEL_KEYS.filter((key) => picked[key]);
  // A post's formats are those of the first social channel (the one its slots
  // are drawn on, plan-layout.ts): every other social channel gets each post
  // in its own format, so only that channel (and Blog/SEO or Ads) asks.
  const postChannel = selected.find(isSocialPlatform);
  const formatChannels = selected.filter(
    (key) =>
      CHANNELS[key].formats.length > 1 &&
      (!isSocialPlatform(key) || key === postChannel),
  );
  const adapted = selected.filter(
    (key) => isSocialPlatform(key) && key !== postChannel,
  );
  const steps: StepKey[] = [
    "goal",
    "channels",
    ...(formatChannels.length > 0 ? (["formats"] as const) : []),
    "rhythm",
  ];
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const isLast = step === "rhythm";
  const storyOn = story && Boolean(picked.instagram);

  const canNext =
    step === "goal"
      ? goal !== null
      : step === "channels"
        ? selected.length > 0
        : step === "formats"
          ? formatChannels.every((key) => (picked[key]?.length ?? 0) > 0)
          : true;

  const briefChannels: PlanBrief["channels"] = selected.map((channel) => ({
    channel,
    formats: picked[channel]!,
  }));
  const coverage = coverageLine({
    channels: briefChannels,
    story: storyOn,
    perWeek,
    weeks,
  });
  const onlySocial = selected.every(isSocialPlatform);
  const tags = prefillTags(prefill, initial);
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
      channels: briefChannels,
      ...(storyOn ? { story: true } : {}),
      perWeek,
      weeks,
      start: startDate(startChoice, card.today, continuation?.continueFrom),
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
            <WsTag key={channel}>
              {CHANNELS[channel].label}
              {channel === "instagram" && sent.story ? ` + ${STORY_LABEL}` : ""}
            </WsTag>
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
          {tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                From your request:
              </span>
              {tags.map((tag) => (
                <WsTag key={tag}>{tag}</WsTag>
              ))}
            </div>
          ) : null}
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
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {offeredChannels.map((key) => {
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
                  <div
                    className="flex items-center rounded-xl border transition-colors"
                    style={{
                      borderColor: on ? "var(--ws-accent)" : "var(--ws-border)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleChannel(key)}
                      aria-pressed={on}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--ws-hover)]"
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
                    {key === "instagram" && on ? (
                      <StoryToggle
                        on={story}
                        onToggle={() => setStory((value) => !value)}
                      />
                    ) : null}
                  </div>
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
          {formatChannels.map((key) => (
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
          {adapted.length > 0 ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {joinNames(adapted.map((key) => CHANNELS[key].label))}{" "}
              {adapted.length === 1
                ? "gets each post in its own format."
                : "get each post in their own format."}
            </p>
          ) : null}
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
          <Row label={onlySocial ? "Posts per week" : "Pieces per week"}>
            {rhythmChoices(PER_WEEK_OPTIONS, initial.perWeek).map((value) => (
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
            {rhythmChoices(WEEKS_OPTIONS, initial.weeks).map((value) => (
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
            {startOptions.map((value) => (
              <Chip
                key={value}
                active={startChoice === value}
                onClick={() => setStartChoice(value)}
              >
                {START_LABEL[value]} ·{" "}
                {formatDate(
                  startDate(value, card.today, continuation?.continueFrom),
                )}
              </Chip>
            ))}
          </Row>
          <label className="block space-y-1">
            <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              Theme or focus (optional)
            </span>
            <Input
              value={theme}
              maxLength={THEME_MAX}
              onChange={(event) => setTheme(event.target.value)}
              placeholder="e.g. new service launch"
            />
          </label>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {coverage}
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
