import { CHANNEL_KEYS, type ChannelConnections, type ChannelKey } from "@/lib/content-channels";
import { channelNeedsConnection } from "@/lib/works/work";

export type OfferWork = {
  id: string;
  title: string;
  channels: readonly ChannelKey[];
  status: string;
};

export type ChannelBackLink = { channel: ChannelKey; workId: string; title: string };

// Today Works have a deterministic `today_` id; they never count as "the Work for a channel".
const TODAY_PREFIX = "today_";

// Keyed on LIVE connection state: a connected channel that an open Work covers
// gets a way back to it; one no open Work covers gets an "open a Work" offer.
// `works` must be newest first.
export function channelOffers(
  connections: ChannelConnections,
  works: readonly OfferWork[],
): { open: ChannelKey[]; back: ChannelBackLink[] } {
  const open: ChannelKey[] = [];
  const back: ChannelBackLink[] = [];
  const candidates = works.filter(
    (w) => w.status === "ACTIVE" && !w.id.startsWith(TODAY_PREFIX),
  );
  for (const channel of CHANNEL_KEYS) {
    if (!channelNeedsConnection(channel)) continue;
    if (!connections[channel]?.connected) continue;
    const covering = candidates.find((w) => w.channels.includes(channel));
    if (covering) back.push({ channel, workId: covering.id, title: covering.title });
    else open.push(channel);
  }
  return { open, back };
}
