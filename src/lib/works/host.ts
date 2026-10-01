import type { ChannelConnections } from "@/lib/content-channels";
import {
  starterCards,
  type StarterCard,
} from "@/lib/works/starter-cards";
import {
  channelOptions,
  gateWorkChannels,
  type ChannelOption,
  type WorkView,
} from "@/lib/works/work";

// What the project page hands the chat for a Work (docs/works.md): the Work
// itself and everything its empty screen needs, worked out on the server.
export type WorkHost = {
  work: WorkView;
  // The chooser's options, with each channel's live connection state.
  channelOptions: ChannelOption[];
  anyConnected: boolean;
  // Empty until a channel is chosen (the chooser comes first).
  starterCards: StarterCard[];
  // The workspace zone, for printing wall-clock times.
  timezone?: string;
};

export function buildWorkHost(input: {
  projectId: string;
  work: WorkView;
  connections: ChannelConnections;
  pendingApprovals: number;
  hasAnalytics: boolean;
  today?: string;
  theme?: string;
  aiOff?: boolean;
  timezone?: string;
}): WorkHost {
  const { work, connections } = input;
  const gate = gateWorkChannels(work.channels, connections);
  const anyConnected = Object.values(connections).some(
    (connection) => connection?.connected === true,
  );
  return {
    work,
    channelOptions: channelOptions(connections),
    anyConnected,
    starterCards: gate.ok
      ? starterCards({
          projectId: input.projectId,
          channels: gate.channels,
          anyConnected,
          pendingApprovals: input.pendingApprovals,
          hasAnalytics: input.hasAnalytics,
          today: input.today,
          theme: input.theme,
          aiOff: input.aiOff,
          fromWorkId: work.id,
        })
      : [],
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
}
