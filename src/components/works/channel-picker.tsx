"use client";

import { Check, Share2 } from "lucide-react";
import * as React from "react";

import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import type { CardButton } from "@/lib/works/card-action";
import type { ChannelKey } from "@/lib/content-channels";
import { integrationsHref } from "@/lib/works/starter-cards";
import type { ChannelOption } from "@/lib/works/work";
import { cn } from "@/lib/utils";
import { setWorkChannelsAction } from "@/server/actions/work-actions";

// The channel gate's card (docs/works.md): pick the channel(s) this Work is for.
// A connected channel is ready to publish; a channel that is not connected may
// still be picked ("I'll connect later"): plans and content are made, publishing
// waits for the connection. Rendered in the chat (the agent's gate) and on an
// empty Work (the first thing it asks).

export const CHANNEL_PICKER_COPY = {
  connected: "Connected",
  notConnected: "Not connected",
  noConnection: "Nothing to connect",
  laterNote:
    "Not connected yet: I'll plan and prepare it now, and publishing starts once you connect it.",
  connectNow: "Connect accounts",
  submit: "Continue",
  saving: "Saving…",
  pick: "Pick at least one channel.",
  failed: "Couldn't save the channels. Try again.",
  groupAria: "Channels for this Work",
} as const;

export function ChannelPickerView({
  title,
  reason,
  options,
  selected,
  pending,
  error,
  connectHref,
  onToggle,
  onSubmit,
}: {
  title: string;
  reason?: string;
  options: readonly ChannelOption[];
  selected: readonly ChannelKey[];
  pending: boolean;
  error: string | null;
  connectHref: string;
  onToggle: (key: ChannelKey) => void;
  onSubmit: () => void;
}) {
  const chosen = options.filter((option) => selected.includes(option.key));
  const hasLater = chosen.some(
    (option) => option.needsConnection && !option.connected,
  );
  const needsConnect = options.some((o) => o.needsConnection && !o.connected);
  const buttons: CardButton[] = [
    {
      id: "channels:submit",
      label: pending ? CHANNEL_PICKER_COPY.saving : CHANNEL_PICKER_COPY.submit,
      emphasis: "primary",
      action: { kind: "server", id: "channels:submit" },
      ...(chosen.length === 0 ? { disabledReason: CHANNEL_PICKER_COPY.pick } : {}),
    },
    ...(needsConnect
      ? [
          {
            id: "channels:connect",
            label: CHANNEL_PICKER_COPY.connectNow,
            emphasis: "quiet" as const,
            action: { kind: "link" as const, href: connectHref },
          },
        ]
      : []),
  ];
  return (
    <ActionCard
      icon={Share2}
      title={title}
      reason={reason}
      width="wide"
      cardId="channel-picker"
      actions={
        <CardActions
          buttons={buttons}
          onAct={(button) => {
            if (button.id === "channels:submit") onSubmit();
          }}
          busyId={pending ? "channels:submit" : null}
          error={error}
        />
      }
    >
      <div
        role="group"
        aria-label={CHANNEL_PICKER_COPY.groupAria}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((option) => {
          const on = selected.includes(option.key);
          const state = !option.needsConnection
            ? CHANNEL_PICKER_COPY.noConnection
            : option.connected
              ? option.accountLabel
                ? `${CHANNEL_PICKER_COPY.connected} · ${option.accountLabel}`
                : CHANNEL_PICKER_COPY.connected
              : CHANNEL_PICKER_COPY.notConnected;
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={on}
              disabled={pending}
              onClick={() => onToggle(option.key)}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
                on ? "border-primary bg-primary/5" : "hover:bg-[var(--ws-hover)]",
              )}
              style={on ? undefined : { borderColor: "var(--ws-border)" }}
            >
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                style={{ background: option.color }}
              >
                {option.short}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-sm font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {option.label}
                </span>
                <span
                  className="block truncate text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {state}
                </span>
              </span>
              {on ? (
                <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
              ) : null}
            </button>
          );
        })}
      </div>
      {hasLater ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {CHANNEL_PICKER_COPY.laterNote}
        </p>
      ) : null}
    </ActionCard>
  );
}

export function ChannelPicker({
  projectId,
  workId,
  options,
  initial,
  title,
  reason,
  onSaved,
}: {
  projectId: string;
  workId: string;
  options: readonly ChannelOption[];
  initial: readonly ChannelKey[];
  title: string;
  reason?: string;
  onSaved?: (channels: ChannelKey[]) => void;
}) {
  const [selected, setSelected] = React.useState<ChannelKey[]>([...initial]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onToggle = React.useCallback((key: ChannelKey) => {
    setError(null);
    setSelected((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key],
    );
  }, []);

  const onSubmit = React.useCallback(() => {
    if (pending) return;
    if (selected.length === 0) {
      setError(CHANNEL_PICKER_COPY.pick);
      return;
    }
    startTransition(async () => {
      const result = await setWorkChannelsAction(projectId, workId, selected);
      if (!result.ok) {
        setError(result.message || CHANNEL_PICKER_COPY.failed);
        return;
      }
      onSaved?.(result.channels);
    });
  }, [pending, selected, projectId, workId, onSaved]);

  return (
    <ChannelPickerView
      title={title}
      reason={reason}
      options={options}
      selected={selected}
      pending={pending}
      error={error}
      // With the way back to this chat (the integrations page offers it).
      connectHref={integrationsHref(projectId, undefined, {
        fromWorkId: workId,
      })}
      onToggle={onToggle}
      onSubmit={onSubmit}
    />
  );
}
