import "server-only";

import type { ChannelKey } from "@/lib/content-channels";
import {
  channelListText,
  channelOptions,
  primaryPlatformOf,
  type WorkView,
} from "@/lib/works/work";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// The server half of the channel gate (docs/works.md). Planning and content
// production only ever target the channels a Work has chosen, and nothing is
// planned or produced before one is chosen. The model is told the same in the
// prompt, but this is the enforcement: a tool calls `channelGateOutcome` first
// and, when it returns an outcome, returns it instead of running.

// What create_task may produce FOR a channel; research and analysis do not need
// one. Publishing capabilities already name their platform.
export const CHANNEL_CONTENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
]);

export type GateContext = {
  projectId: string;
  work?: WorkView;
};

// The tool outcome shape the agent loop understands (kept structural so this
// module does not import tools.ts back).
export type GateOutcome = {
  status: "ANSWERED";
  card: IdeaEventCardData;
  result: { outcome: string; note: string };
};

// null = the gate is open (no Work in play, or it has a channel).
export async function channelGateOutcome(
  ctx: GateContext,
): Promise<GateOutcome | null> {
  const work = ctx.work;
  if (!work || work.channels.length > 0) return null;
  const connections = await getChannelConnections(ctx.projectId).catch(
    () => ({}),
  );
  return {
    status: "ANSWERED",
    card: {
      kind: "channel-select",
      projectId: ctx.projectId,
      workId: work.id,
      options: channelOptions(connections),
      selected: [],
    },
    result: {
      outcome: "channel_question_shown",
      note: "Nothing was planned or created. The client sees a card to choose which channel(s) this Work is for (connected ones, or \"I'll connect later\"). Say in one short sentence that you need the channel first; when they answer, carry on with their original request.",
    },
  };
}

// A platform the model named that this Work does not target. The Work's
// channels decide; adding one is the client's tap on the card, not the model's
// call. null = fine.
export function platformOutsideWork(
  work: WorkView | undefined,
  platform: string | undefined,
): { error: string; note: string } | null {
  if (!work || !platform || work.channels.length === 0) return null;
  const allowed = work.channels
    .map((key) => platformOfChannel(key))
    .filter((p): p is string => Boolean(p));
  if (allowed.length === 0 || allowed.includes(platform)) return null;
  return {
    error: `This Work targets ${channelListText(work.channels)}, not ${platform}.`,
    note: "Use one of this Work's channels, or tell the client they can add the channel to this Work or open a new Work for it. Do not switch channel on your own.",
  };
}

// A plan item on a channel the Work does not target. null = fine. The message
// goes back to the model as the tool's error, so it repairs the plan.
export function planOutsideWork(
  work: WorkView | undefined,
  items: readonly { channel?: string; platform?: string }[],
): string | null {
  if (!work || work.channels.length === 0) return null;
  const outside = [
    ...new Set(
      items
        // An item names its channel, or (older plans) a platform that is the
        // channel's name in capitals; one that names neither is checked elsewhere.
        .map((item) => item.channel ?? item.platform?.toLowerCase())
        .filter(
          (channel): channel is string =>
            channel !== undefined &&
            !work.channels.includes(channel as ChannelKey),
        ),
    ),
  ];
  if (outside.length === 0) return null;
  return `This Work is for ${channelListText(work.channels)}; the plan has items on ${outside.join(", ")}. Keep only this Work's channels.`;
}

// The platform to use when the model did not name one.
export function defaultPlatformOf(work: WorkView | undefined) {
  return work ? primaryPlatformOf(work.channels) : undefined;
}

function platformOfChannel(key: ChannelKey): string | undefined {
  return primaryPlatformOf([key]);
}
