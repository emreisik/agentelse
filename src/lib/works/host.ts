import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import { todayKeyIn } from "@/lib/date-picker";
import type { ModuleKey } from "@/lib/modules/catalog";
import {
  chatDefaultChannels,
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
  // The module this chat is for (src/lib/modules), null for a general chat.
  // Always null while modules are off: read this, not work.module.
  module: ModuleKey | null;
  // Modules are on (MODULES_UI): a new chat opens into them.
  modulesUi: boolean;
  // The chooser's options, with each channel's live connection state.
  channelOptions: ChannelOption[];
  anyConnected: boolean;
  // What a chat with no stored channel starts with (the connected publishing
  // channels, at most three, else Instagram): the chat route stores them with
  // its first message. Empty once the chat has channels. Defaults only: a chat
  // is not bound to a channel.
  defaultChannels: ChannelKey[];
  // The suggestions under the composer, for the channels the chat shows as
  // chosen (its own, or the default ones).
  starterCards: StarterCard[];
  // The workspace zone, for printing wall-clock times.
  timezone?: string;
  // The project's day (YYYY-MM-DD in its own timezone) as the server read it,
  // and the brand's current focus: what a new plan starts from (the Social
  // Media Planner's Brief, module-start.tsx).
  today: string;
  theme?: string;
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
  // isModulesEnabled(), read by the page. Absent = off.
  modulesUi?: boolean;
}): WorkHost {
  const { work, connections } = input;
  const modulesUi = input.modulesUi === true;
  const options = channelOptions(connections);
  const defaultChannels =
    work.channels.length === 0 ? chatDefaultChannels(options) : [];
  const gate = gateWorkChannels(
    work.channels.length > 0 ? work.channels : defaultChannels,
    connections,
  );
  const anyConnected = Object.values(connections).some(
    (connection) => connection?.connected === true,
  );
  return {
    work,
    module: modulesUi ? (work.module ?? null) : null,
    modulesUi,
    channelOptions: options,
    anyConnected,
    defaultChannels,
    starterCards: starterCards({
      projectId: input.projectId,
      channels: gate.ok ? gate.channels : [],
      anyConnected,
      pendingApprovals: input.pendingApprovals,
      hasAnalytics: input.hasAnalytics,
      today: input.today,
      theme: input.theme,
      aiOff: input.aiOff,
      fromWorkId: work.id,
    }),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    // The page passes its day; without it, the day in the project's timezone.
    today: input.today ?? todayKeyIn(input.timezone),
    ...(input.theme ? { theme: input.theme } : {}),
  };
}
