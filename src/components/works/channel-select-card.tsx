"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useChatSend } from "@/components/commands/chat-send-context";
import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import { ChannelPicker } from "@/components/works/channel-picker";
import { channelListText } from "@/lib/works/work";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type Card = Extract<IdeaEventCardData, { kind: "channel-select" }>;

export const CHANNEL_SELECT_COPY = {
  title: "Which channel is this Work for?",
  reason:
    "Plans and content are made for the channels you pick. A channel you haven't connected yet is fine: publishing starts once it is connected.",
  doneLead: "Channels for this Work:",
  change: "Change",
} as const;

// "Continue with Instagram and LinkedIn." — the chat resumes the request the
// agent could not start before a channel was chosen.
export function continueMessage(channels: readonly Card["selected"][number][]) {
  return `Continue with ${channelListText(channels)}.`;
}

// Resolved (the Work already has channels): one quiet line instead of the
// chooser, with a way back to it.
export function ChannelSelectDone({
  channels,
  onChange,
}: {
  channels: Card["selected"];
  onChange: () => void;
}) {
  return (
    <ActionCard
      icon={Check}
      title={CHANNEL_SELECT_COPY.title}
      width="wide"
      cardId="channel-select"
      resolved={`${CHANNEL_SELECT_COPY.doneLead} ${channelListText(channels)}`}
      actions={
        <CardActions
          buttons={[
            {
              id: "channel-select:change",
              label: CHANNEL_SELECT_COPY.change,
              emphasis: "quiet",
              action: { kind: "server", id: "channel-select:change" },
            },
          ]}
          onAct={onChange}
        />
      }
    />
  );
}

export function ChannelSelectCard({ card }: { card: Card }) {
  const send = useChatSend();
  const router = useRouter();
  const [saved, setSaved] = React.useState<Card["selected"] | null>(null);
  const [editing, setEditing] = React.useState(false);
  const current = saved ?? (card.selected.length > 0 ? card.selected : null);

  if (current && !editing) {
    return (
      <ChannelSelectDone channels={current} onChange={() => setEditing(true)} />
    );
  }
  return (
    <ChannelPicker
      projectId={card.projectId}
      workId={card.workId}
      options={card.options}
      initial={current ?? []}
      title={CHANNEL_SELECT_COPY.title}
      reason={CHANNEL_SELECT_COPY.reason}
      onSaved={(channels) => {
        setSaved(channels);
        setEditing(false);
        router.refresh();
        // The first time, resume the request the gate stopped.
        if (!current && send) void send(continueMessage(channels));
      }}
    />
  );
}
