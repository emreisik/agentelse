"use client";

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDiscovery } from "@/components/discovery/discovery-context";
import type { DiscoveryEntry } from "@/components/discovery/discovery-entry";
import {
  readChipDismissed,
  writeChipDismissed,
} from "@/components/guide/guided-setup-entry";

// The Welcome card and the chip of the discovery flow. Rules (who sees what)
// come only from discoveryEntryOf() via `entry`.

const TOUCH = "any-pointer-coarse:min-h-11";

const BLURB: Record<DiscoveryEntry["kind"], string> = {
  start: "Add your website and Agentelse learns your brand for you.",
  running: "Your brand profile is being put together.",
  review: "Check what was found and confirm it.",
  update: "",
};

export function DiscoveryWelcomeCard({
  entry,
  disabled,
  onOpen,
}: {
  entry: DiscoveryEntry;
  disabled: boolean;
  onOpen: () => void;
}) {
  if (!entry.welcome) return null;
  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border bg-card p-4 text-left">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <ClipboardList className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{entry.label}</p>
        <p className="text-sm text-muted-foreground">{BLURB[entry.kind]}</p>
      </div>
      <Button
        type="button"
        size="sm"
        className={TOUCH}
        disabled={disabled}
        onClick={onOpen}
      >
        {entry.kind === "start" ? "Start" : "Open"}
      </Button>
    </div>
  );
}

export function DiscoveryChip({
  entry,
  threadEmpty,
  dismissed,
  disabled,
  onOpen,
  onDismiss,
}: {
  entry: DiscoveryEntry;
  threadEmpty: boolean;
  dismissed: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  // On an empty thread the Welcome card is the entry: never both.
  if (!entry.chip || threadEmpty || dismissed) return null;
  return (
    <div className="mb-2 flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn("rounded-full", TOUCH)}
        disabled={disabled}
        onClick={onOpen}
      >
        {entry.label}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn("rounded-full text-muted-foreground", TOUCH)}
        onClick={onDismiss}
      >
        Not now
      </Button>
    </div>
  );
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function ConnectedDiscoveryWelcomeCard() {
  const api = useDiscovery();
  if (!api) return null;
  return (
    <DiscoveryWelcomeCard
      entry={api.entry}
      disabled={api.isOpen}
      onOpen={() => api.open("welcome")}
    />
  );
}

export function ConnectedDiscoveryChip({ projectId }: { projectId: string }) {
  const api = useDiscovery();
  const messageCount = useAuiState((s) => s.thread.messages.length);
  // Server snapshot is "dismissed" so server and first client render agree.
  const dismissed = React.useSyncExternalStore(
    subscribe,
    () => readChipDismissed(projectId),
    () => true,
  );
  if (!api) return null;
  return (
    <DiscoveryChip
      entry={api.entry}
      threadEmpty={messageCount === 0}
      dismissed={dismissed}
      disabled={api.isOpen}
      onOpen={() => api.open("chip")}
      onDismiss={() => {
        writeChipDismissed(projectId);
        listeners.forEach((l) => l());
      }}
    />
  );
}
