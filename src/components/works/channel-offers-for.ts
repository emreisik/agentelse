import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import { channelOffers } from "@/lib/works/channel-offers";

// Server-side gate of the integrations banner: only with Works on, only for
// connected channels no open Work covers. Lives outside the 'use client'
// banner module so the page can call it.
export function offersFor(
  worksEnabled: boolean,
  connections: ChannelConnections,
  coverage: readonly { id: string; channels: readonly ChannelKey[]; status: string }[],
): ChannelKey[] {
  if (!worksEnabled) return [];
  // Coverage rows carry no title: only the `open` side is used here.
  return channelOffers(
    connections,
    coverage.map((w) => ({ ...w, title: "" })),
  ).open;
}
