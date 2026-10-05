import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import type { CardAction } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import {
  channelListText,
  channelNeedsConnection,
  integrationParamOf,
  type WorkChannelState,
} from "@/lib/works/work";

// What a new chat suggests under its composer (docs/works.md): instead of a
// blank screen and free-text chips, the next useful moves, each as one line with
// the reason it is offered. Pure: the server gathers the facts, this decides the
// cards, the client renders them and maps an action to a send / a link / a panel.

export type StarterAction = Exclude<CardAction, { kind: "server" }>;

export type StarterCard = {
  id: string;
  // The one sentence the new chat's list shows (ChatGPT's suggestion rows);
  // the reason is its tooltip.
  line: string;
  reason: string;
  // What a tap does.
  action: StarterAction;
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

// A free chat's default channels (docs/works.md): the connected publishing
// channels, at most three; Instagram, the standard everything is made for, while
// nothing is connected (publishing then waits for a connection). They are only
// defaults: the client's words and every plan item decide the real channel.
export function chatDefaultChannels(
  options: readonly { key: ChannelKey; connected: boolean }[],
): ChannelKey[] {
  const connected = options
    .filter((o) => o.connected && CHANNELS[o.key].group === "social")
    .map((o) => o.key)
    .slice(0, 3);
  return connected.length > 0 ? connected : ["instagram"];
}

// The first tap takes 10-25 s: which pending line the chat shows meanwhile.
export function pendingHintFor(
  messageText: string,
): "plan" | "ideas" | "generic" {
  if (messageText.includes("[Plan brief]")) return "plan";
  if (messageText.startsWith("Give me content ideas")) return "ideas";
  return "generic";
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function starterCards(facts: StarterFacts): StarterCard[] {
  const { channels } = facts;
  if (channels.length === 0) {
    // Nothing chosen and nothing to start with. The channel picker sits in the
    // composer, so with an account connected there is nothing to add here; with
    // none, the useful first move is connecting one (or planning before it).
    return facts.anyConnected
      ? []
      : [
          {
            id: "connect-first",
            line: "Connect a channel",
            reason:
              "Plans and content are made for a channel. You can plan before connecting; publishing starts once it is connected.",
            action: {
              kind: "link",
              href: integrationsHref(facts.projectId, undefined, {
                fromWorkId: facts.fromWorkId,
              }),
            },
          },
        ];
  }

  const keys = channels.map((c) => c.key);
  const named = channelListText(keys);
  const locked = channels.filter((c) => c.publishLocked);
  const cards: StarterCard[] = [];

  if (facts.aiOff) {
    cards.push({
      id: "ai-off",
      line: copyText("starter.aiOff.title"),
      reason: copyText("starter.aiOff.reason"),
      action: { kind: "tab", tab: "calendar" },
    });
  } else {
    cards.push({
      id: "plan-week",
      line: `Plan the week for ${named}`,
      reason: copyText("starter.planWeek.reason", { named }),
      action: { kind: "send", text: `Plan the week for ${named}.` },
    });

    cards.push({
      id: "ideas",
      line: `Find content ideas for ${named}`,
      reason: copyText("starter.ideas.reason", { named }),
      action: {
        kind: "send",
        text: `Give me content ideas for ${named}.`,
      },
    });

    // Slot-first generation needs the model too, so it hides when AI is off.
    const postChannel = channels.find(
      (c) => CHANNELS[c.key].group === "social",
    );
    if (postChannel) {
      cards.push({
        id: "make-post",
        line: `Make one post for ${postChannel.label}`,
        reason: copyText("starter.makePost.reason", {
          channel: postChannel.label,
        }),
        action: {
          kind: "send",
          text: `Make one post for ${postChannel.label}.`,
        },
      });
    }
  }

  // One more card, by priority: decisions, then connect, then performance.
  if (facts.pendingApprovals > 0) {
    cards.push({
      id: "decisions",
      line: `${plural(facts.pendingApprovals, "decision", "decisions")} waiting for you`,
      reason: "Approve, revise or reject what is ready so it can move on.",
      action: { kind: "tab", tab: "outputs" },
    });
  } else if (locked[0]) {
    const firstLocked = locked[0];
    cards.push({
      id: "connect",
      line: `Connect ${firstLocked.label} to publish`,
      reason: `You can plan and prepare ${locked.map((c) => c.label).join(", ")} now; publishing starts once it is connected.`,
      action: {
        kind: "link",
        href: integrationsHref(facts.projectId, firstLocked.key, {
          fromWorkId: facts.fromWorkId,
        }),
      },
    });
  } else if (facts.hasAnalytics) {
    cards.push({
      id: "performance",
      line: "Check how your content is performing",
      reason: "What worked lately, and what to do next.",
      action: { kind: "send", text: "How is our performance lately?" },
    });
  }

  return cards.slice(0, MAX_STARTER_CARDS);
}

// With modules on (MODULES_UI) the New Chat's module tiles start the planning,
// the ideas, a post and the performance report: of these rows only the ones no
// module covers stay under the tiles (a decision waiting, a channel to connect,
// AI switched off), in their order.
export const MODULE_STARTER_IDS: readonly string[] = [
  "decisions",
  "connect",
  "connect-first",
  "ai-off",
];

export function moduleStarterCards(
  cards: readonly StarterCard[],
): StarterCard[] {
  return cards.filter((card) => MODULE_STARTER_IDS.includes(card.id));
}

// A channel label for a key, for screens that only hold keys.
export function channelLabel(key: ChannelKey): string {
  return CHANNELS[key].label;
}

// Whether connecting matters for this key at all (SEO never does).
export function canConnect(key: ChannelKey): boolean {
  return channelNeedsConnection(key);
}
