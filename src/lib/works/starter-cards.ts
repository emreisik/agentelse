import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import { serializePlanBrief } from "@/lib/plan-brief";
import type { CardAction } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import { defaultPlanBrief } from "@/lib/works/plan-layout";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import {
  channelListText,
  channelNeedsConnection,
  integrationParamOf,
  type WorkChannelState,
} from "@/lib/works/work";

// The cards an empty Work opens with (docs/works.md): instead of a blank
// screen and free-text chips, the next useful moves, each with the reason it is
// offered. Pure: the server gathers the facts, this decides the cards, the
// client renders them and maps an action to a send / a link / a panel.

export type StarterAction = Exclude<CardAction, { kind: "server" }>;

export type StarterCard = {
  id: string;
  title: string;
  reason: string;
  primary: { label: string; action: StarterAction };
  secondary?: { label: string; action: StarterAction };
};

export type StarterFacts = {
  projectId: string;
  // The Work's chosen channels with their live connection state.
  channels: readonly WorkChannelState[];
  // Is ANY publishing channel connected on the project (drives the first card
  // of a Work that has no channel yet).
  anyConnected: boolean;
  pendingApprovals: number;
  // GA4 / Search Console / Meta Ads: something to read performance from.
  hasAnalytics: boolean;
  // Optional so callers can land before the page passes them: without `today`
  // the plan-week card falls back to the plain sentence and builds no brief.
  today?: string;
  theme?: string;
  // Mock mode / AI switched off: cards that need the model are replaced.
  aiOff?: boolean;
  fromWorkId?: string;
};

export const MAX_STARTER_CARDS = 4;

export function integrationsHref(
  projectId: string,
  key?: ChannelKey,
  options?: { fromWorkId?: string },
): string {
  const params: string[] = [];
  const provider = key ? integrationParamOf(key) : undefined;
  if (provider) params.push(`integration=${provider}`);
  if (options?.fromWorkId) {
    params.push(`from=${encodeURIComponent(options.fromWorkId)}`);
  }
  return `/projects/${projectId}/integrations${params.length ? `?${params.join("&")}` : ""}`;
}

// The first screen should not be an empty channel form: pre-select the
// connected publishing channels when there are one to three of them.
export function defaultChannelSelection(
  options: readonly { key: ChannelKey; connected: boolean }[],
): ChannelKey[] {
  const connected = options
    .filter((o) => o.connected && CHANNELS[o.key].group === "social")
    .map((o) => o.key);
  return connected.length >= 1 && connected.length <= 3 ? connected : [];
}

// The first tap takes 10-25 s: which pending line the chat shows meanwhile.
export function pendingHintFor(messageText: string): "plan" | "ideas" | "generic" {
  if (messageText.includes("[Plan brief]")) return "plan";
  if (messageText.startsWith("Give me content ideas")) return "ideas";
  return "generic";
}

// "Plan the week · from Fri 2 Oct" on the first line (never an ISO date), the
// machine brief line second; the bubble hides the machine line. Null when no
// brief can be built (the caller falls back to the plain sentence).
function starterPlanMessage(facts: StarterFacts): string | null {
  if (!facts.today) return null;
  const brief = defaultPlanBrief({
    channels: facts.channels.map((c) => c.key),
    today: facts.today,
    theme: facts.theme,
  });
  if (!brief) return null;
  const machine = serializePlanBrief(brief).split("\n")[1];
  if (!machine) return null;
  const when = slotWhenLabel(brief.start, "").split(",")[0] ?? brief.start;
  return `${copyText("starter.planWeek.visible", { when })}\n${machine}`;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// A Work with no channel chosen: the only useful first move is choosing one
// (the chooser itself is rendered by the screen, this is its framing). Kept as
// a function so the copy lives with the rest of the starter rules.
export function channelChoiceFraming(anyConnected: boolean): {
  title: string;
  reason: string;
} {
  return anyConnected
    ? {
        title: "Which channel is this Work for?",
        reason:
          "Everything here is planned and made for the channels you pick, so pick first.",
      }
    : {
        title: "Connect a channel, or pick one to plan for",
        reason:
          "Plans and content are made for a channel. You can plan before connecting; publishing starts once it is connected.",
      };
}

export function starterCards(facts: StarterFacts): StarterCard[] {
  const { channels } = facts;
  if (channels.length === 0) return [];

  const keys = channels.map((c) => c.key);
  const named = channelListText(keys);
  const locked = channels.filter((c) => c.publishLocked);
  const cards: StarterCard[] = [];

  if (facts.aiOff) {
    cards.push({
      id: "ai-off",
      title: copyText("starter.aiOff.title"),
      reason: copyText("starter.aiOff.reason"),
      primary: {
        label: copyText("starter.aiOff.primary"),
        action: { kind: "tab", tab: "calendar" },
      },
    });
  } else {
    cards.push({
      id: "plan-week",
      title: "Plan the week",
      reason: copyText("starter.planWeek.reason", { named }),
      primary: {
        label: "Plan the week",
        action: {
          kind: "send",
          text: starterPlanMessage(facts) ?? `Plan the week for ${named}.`,
        },
      },
      secondary: {
        label: copyText("starter.planWeek.secondary"),
        action: { kind: "send", text: `Plan the week for ${named}.` },
      },
    });

    cards.push({
      id: "ideas",
      title: "Find content ideas",
      reason: copyText("starter.ideas.reason", { named }),
      primary: {
        label: "Give me ideas",
        action: {
          kind: "send",
          text: `Give me content ideas for ${named}.`,
        },
      },
    });

    // Slot-first generation needs the model too, so it hides when AI is off.
    const postChannel = channels.find((c) => CHANNELS[c.key].group === "social");
    if (postChannel) {
      cards.push({
        id: "make-post",
        title: copyText("starter.makePost.title"),
        reason: copyText("starter.makePost.reason", { channel: postChannel.label }),
        primary: {
          label: copyText("starter.makePost.primary"),
          action: { kind: "send", text: `Make one post for ${postChannel.label}.` },
        },
      });
    }
  }

  // One more card, by priority: decisions, then connect, then performance.
  if (facts.pendingApprovals > 0) {
    cards.push({
      id: "decisions",
      title: `${plural(facts.pendingApprovals, "decision", "decisions")} waiting`,
      reason: "Approve, revise or reject what is ready so it can move on.",
      primary: {
        label: "Review",
        action: { kind: "tab", tab: "outputs" },
      },
    });
  } else if (locked[0]) {
    const firstLocked = locked[0];
    cards.push({
      id: "connect",
      title: `Connect ${firstLocked.label}`,
      reason: `You can plan and prepare ${locked.map((c) => c.label).join(", ")} now; publishing starts once it is connected.`,
      primary: {
        label: "Connect",
        action: {
          kind: "link",
          href: integrationsHref(facts.projectId, firstLocked.key, {
            fromWorkId: facts.fromWorkId,
          }),
        },
      },
    });
  } else if (facts.hasAnalytics) {
    cards.push({
      id: "performance",
      title: "Check performance",
      reason: "What worked lately, and what to do next.",
      primary: {
        label: "Check performance",
        action: { kind: "send", text: "How is our performance lately?" },
      },
    });
  }

  return cards.slice(0, MAX_STARTER_CARDS);
}

// A channel label for a key, for screens that only hold keys.
export function channelLabel(key: ChannelKey): string {
  return CHANNELS[key].label;
}

// Whether connecting matters for this key at all (SEO never does).
export function canConnect(key: ChannelKey): boolean {
  return channelNeedsConnection(key);
}
