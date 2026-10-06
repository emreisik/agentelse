import { isChannelKey, type ChannelKey } from "@/lib/content-channels";
import { activePlatformsOf, groupPosts } from "@/lib/works/plan-platforms";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Long cards of a chat are shown as ONE compact card, like ChatGPT's canvas
// cards (docs/works.md): an icon, a title, one line about what is inside and a
// status. Tapping it opens the whole card in the pane on the right, which
// scrolls on its own. This is the pure half: which cards collapse, and what
// their compact card says. Cards that are short anyway (a decision, one planned
// slot, a picture) stay in the chat as they are.

export type CompactIcon =
  "directions" | "ideas" | "master" | "plan" | "package" | "ads";

export type CompactTone =
  "neutral" | "positive" | "waiting" | "danger" | "special";

export type CompactCardSpec = {
  icon: CompactIcon;
  title: string;
  // One line: what is inside ("3 directions · 3 posts").
  subtitle: string;
  // The channels the card is for: shown as their brand marks after the subtitle.
  channels?: ChannelKey[];
  // Where the card stands, when it has a state worth showing.
  status?: { label: string; tone: CompactTone };
};

// The id of the pane's region: the compact card's aria-controls points at it.
export const DETAIL_PANE_ID = "workspace-detail";

export const COMPACT_COPY = {
  planTitle: "Social media plan",
  open: "Open",
  replaced: "Replaced",
  pickDirection: "Pick a direction",
  draft: "Draft",
  saved: "Saved",
  producing: "Producing",
  adapted: "Adapted",
  adapting: "Adapting…",
  pickPieces: "Pick pieces",
  decision: "Decision needed",
  error: "Error",
  paneClose: "Close",
  paneGone: "This item is no longer in the chat.",
} as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "2026-10-03" -> "Oct 3". No Date object: a calendar day has no time zone.
export function shortDay(day: string): string | null {
  const match = DATE_RE.exec(day);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : null;
}

// "Oct 3 – Oct 9", or "Oct 3" for one day; null when no item has a day.
export function dayRange(days: readonly string[]): string | null {
  const valid = days.filter((day) => DATE_RE.test(day)).sort();
  const first = valid[0] ? shortDay(valid[0]) : null;
  const last = valid.at(-1) ? shortDay(valid.at(-1) ?? "") : null;
  if (!first || !last) return null;
  return first === last ? first : `${first} – ${last}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The channels a card is for, from the raw keys it stores: the known ones, once
// each, in the order they come.
export function channelKeysOf(keys: readonly string[]): ChannelKey[] {
  return [...new Set(keys.filter(isChannelKey))];
}

// `{ channels }` when there is anything to show, else nothing.
function channelsOf(keys: readonly string[]): { channels?: ChannelKey[] } {
  const channels = channelKeysOf(keys);
  return channels.length > 0 ? { channels } : {};
}

function join(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

// A plan of one post that went straight onto the calendar from an idea, a
// brief, a suggestion or slot-first generation is the planned-slot card: short,
// so it stays in the chat. Only once it is saved: the planned-slot card says
// "Added to your calendar" and acts on the post, so a draft of one post (not
// on the calendar yet) is a plan card like any other, with its Save and
// Prepare content.
const COMPACT_VIA: ReadonlySet<string> = new Set([
  "idea",
  "generate",
  "suggestion",
  "brief",
]);

type PlanDraft = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

export function isSingleSlotPlan(card: PlanDraft): boolean {
  return (
    card.state !== "draft" &&
    card.items.length === 1 &&
    Boolean(card.via && COMPACT_VIA.has(card.via))
  );
}

// Null: the card stays in the chat as it is.
export function compactSpecOf(card: IdeaEventCardData): CompactCardSpec | null {
  switch (card.kind) {
    case "content-plan-options":
      return {
        icon: "directions",
        title: card.title,
        subtitle: join([
          plural(card.options.length, "direction", "directions"),
          plural(card.slots.length, "post", "posts"),
        ]),
        ...channelsOf([
          ...card.slots.map((slot) => slot.channel),
          ...(card.platforms ?? []),
        ]),
        status:
          card.state === "superseded"
            ? { label: COMPACT_COPY.replaced, tone: "neutral" }
            : { label: COMPACT_COPY.pickDirection, tone: "waiting" },
      };

    case "idea-options": {
      const planned = Object.keys(card.scheduled ?? {}).length;
      return {
        icon: "ideas",
        title: card.title,
        subtitle: join([
          plural(card.items.length, "idea", "ideas"),
          planned > 0 && `${planned} planned`,
        ]),
        ...(planned > 0
          ? {
              status: {
                label: `${planned} planned`,
                tone: "positive" as const,
              },
            }
          : {}),
      };
    }

    case "master-content": {
      const channels = card.targets.filter((target) => target.included);
      return {
        icon: "master",
        title: card.title,
        subtitle: join([
          plural(channels.length, "channel", "channels"),
        ]),
        ...channelsOf(channels.map((target) => target.channel)),
        status: card.adapting
          ? { label: COMPACT_COPY.adapting, tone: "waiting" }
          : card.state === "superseded"
            ? { label: COMPACT_COPY.replaced, tone: "neutral" }
            : card.state === "adapted"
              ? { label: COMPACT_COPY.adapted, tone: "positive" }
              : { label: COMPACT_COPY.draft, tone: "waiting" },
      };
    }

    case "content-plan-draft": {
      if (isSingleSlotPlan(card)) return null;
      const items = card.items.filter((item) => !item.removed);
      return {
        icon: "plan",
        // A plan is general (not Instagram's): one name for every plan.
        title: COMPACT_COPY.planTitle,
        subtitle: join([
          plural(groupPosts(items).length, "post", "posts"),
          dayRange(items.map((item) => item.date)),
        ]),
        ...channelsOf(activePlatformsOf(card)),
        status:
          card.state === "superseded"
            ? { label: COMPACT_COPY.replaced, tone: "neutral" }
            : card.production?.state === "running"
              ? { label: COMPACT_COPY.producing, tone: "waiting" }
              : card.state === "saved"
                ? { label: COMPACT_COPY.saved, tone: "positive" }
                : { label: COMPACT_COPY.draft, tone: "waiting" },
      };
    }

    case "content-package":
      return {
        icon: "package",
        title: card.topic,
        subtitle: plural(card.items.length, "piece", "pieces"),
        status:
          card.state === "superseded"
            ? { label: COMPACT_COPY.replaced, tone: "neutral" }
            : card.state === "started"
              ? {
                  label: `${card.startedCount ?? card.items.length} started`,
                  tone: "positive",
                }
              : { label: COMPACT_COPY.pickPieces, tone: "waiting" },
      };

    case "ads-insight":
      return {
        icon: "ads",
        title: "Meta Ads",
        subtitle:
          card.headline ?? card.campaignName ?? "How your campaigns are doing",
        ...(card.proposal?.state === "pending"
          ? { status: { label: COMPACT_COPY.decision, tone: "waiting" as const } }
          : card.state === "error"
            ? { status: { label: COMPACT_COPY.error, tone: "danger" as const } }
            : {}),
      };

    default:
      return null;
  }
}
