import "server-only";

import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import { chatDefaultChannels } from "@/lib/works/starter-cards";
import { channelNeedsConnection, channelOptions } from "@/lib/works/work";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { WorkRepository } from "@/server/repositories/work.repository";

// Which of the chosen channels are not connected right now ("I'll connect
// later"): stored with the choice so the screen can tell a deliberate choice from
// a gap.
export async function unconnectedOf(
  projectId: string,
  channels: ChannelKey[],
): Promise<ChannelKey[]> {
  const connections: ChannelConnections = await getChannelConnections(
    projectId,
  ).catch(() => ({}));
  return channels.filter(
    (key) => channelNeedsConnection(key) && !connections[key]?.connected,
  );
}

// A chat is free (docs/works.md): it asks for no channel. What it needs are
// defaults for the pieces whose channel the client does not name: the connected
// publishing channels (at most three), Instagram while nothing is connected. The
// chat route stores them HERE when a message finds a chat with none, BEFORE the
// message becomes a Command, so the tools of that very turn see them. Nothing is
// asked of the screen and nothing sits in front of the message.
//
// Conditional (WorkRepository.setInitialChannels): never overwrites channels
// stored meanwhile. false = nothing was stored.
export async function applyDefaultChannels(input: {
  projectId: string;
  workId: string;
}): Promise<boolean> {
  const connections: ChannelConnections = await getChannelConnections(
    input.projectId,
  ).catch(() => ({}));
  const chosen = chatDefaultChannels(channelOptions(connections));
  return WorkRepository.setInitialChannels(
    input.projectId,
    input.workId,
    chosen,
    chosen.filter(
      (key) => channelNeedsConnection(key) && !connections[key]?.connected,
    ),
  );
}
