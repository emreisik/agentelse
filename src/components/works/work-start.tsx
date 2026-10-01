"use client";

import { ChannelPicker } from "@/components/works/channel-picker";
import { StarterCardsView } from "@/components/works/starter-cards";
import type { ChannelKey } from "@/lib/content-channels";
import type { WorkHost } from "@/lib/works/host";
import {
  channelChoiceFraming,
  defaultChannelSelection,
  type StarterAction,
} from "@/lib/works/starter-cards";

// The empty Work: the channel chooser first (nothing is planned before a
// channel is chosen), then the next-step cards.
export function WorkStart({
  projectId,
  host,
  disabled,
  onAct,
  onChannelsSaved,
}: {
  projectId: string;
  host: WorkHost;
  disabled: boolean;
  onAct: (action: StarterAction) => void;
  onChannelsSaved: (channels: ChannelKey[]) => void;
}) {
  if (host.work.channels.length === 0) {
    const framing = channelChoiceFraming(host.anyConnected);
    return (
      <div className="mt-6">
        <ChannelPicker
          projectId={projectId}
          workId={host.work.id}
          options={host.channelOptions}
          initial={defaultChannelSelection(host.channelOptions)}
          title={framing.title}
          reason={framing.reason}
          onSaved={onChannelsSaved}
        />
      </div>
    );
  }
  return (
    <StarterCardsView
      cards={host.starterCards}
      disabled={disabled}
      onAct={onAct}
    />
  );
}
