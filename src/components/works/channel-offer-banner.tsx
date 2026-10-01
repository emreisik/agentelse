"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { workHref } from "@/components/layout/work-list";
import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import { copyText } from "@/lib/works/copy";
import { openChannelWorkAction } from "@/server/actions/work-actions";

export function ChannelOfferBannerView({
  channels,
  pendingKey,
  error,
  onOpen,
}: {
  channels: readonly ChannelKey[];
  pendingKey: ChannelKey | null;
  error: string | null;
  onOpen: (channel: ChannelKey) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="space-y-2">
      {channels.map((channel) => (
        <div
          key={channel}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
        >
          <p className="text-sm">{copyText("cta.connected", { channel: CHANNELS[channel].label })}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pendingKey !== null}
            onClick={() => onOpen(channel)}
          >
            {pendingKey === channel
              ? copyText("cta.opening")
              : copyText("cta.open", { channel: CHANNELS[channel].label })}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ChannelOfferBanner({
  projectId,
  channels,
}: {
  projectId: string;
  channels: readonly ChannelKey[];
}) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = React.useState<ChannelKey | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const open = React.useCallback(
    async (channel: ChannelKey) => {
      setPendingKey(channel);
      setError(null);
      try {
        const result = await openChannelWorkAction(projectId, channel);
        if (!result.ok) {
          setError(copyText("cta.failed"));
          return;
        }
        router.push(workHref(projectId, result.workId));
      } catch {
        setError(copyText("cta.failed"));
      } finally {
        setPendingKey(null);
      }
    },
    [projectId, router],
  );

  return <ChannelOfferBannerView channels={channels} pendingKey={pendingKey} error={error} onOpen={open} />;
}
