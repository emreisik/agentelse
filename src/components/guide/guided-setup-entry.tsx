"use client";

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useGuidedSetup } from "@/components/guide/guided-setup-context";
import type { GuidedEntry } from "@/lib/guided-setup/contract";

// Entry rules (who sees what) come only from entryOf() via `entry`; these
// components add the thread-empty split and the chip's "Not now".

// These are the only way into setup on a phone: a finger-sized target there,
// the compact size with a mouse.
const TOUCH = "any-pointer-coarse:min-h-11";

type EntryProps = {
  entry: GuidedEntry;
  disabled: boolean;
  onOpen: () => void;
};

export function GuidedSetupWelcomeCard({
  entry,
  projectName,
  disabled,
  onOpen,
}: EntryProps & { projectName: string }) {
  if (!entry.welcome) return null;
  const isContinue = entry.kind === "continue";
  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border bg-card p-4 text-left">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <ClipboardList className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Set up {projectName}</p>
        <p className="text-sm text-muted-foreground">
          Answer a few questions with buttons. It takes about two minutes.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        className={TOUCH}
        disabled={disabled}
        onClick={onOpen}
      >
        {isContinue ? "Continue setup" : "Start setup"}
      </Button>
    </div>
  );
}

export function GuidedSetupChip({
  entry,
  threadEmpty,
  dismissed,
  disabled,
  onOpen,
  onDismiss,
}: EntryProps & {
  threadEmpty: boolean;
  dismissed: boolean;
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

const dismissKey = (projectId: string) => `guided-setup-chip-dismissed:${projectId}`;

// localStorage is a per-viewer convenience and may throw (private mode).
export function readChipDismissed(projectId: string): boolean {
  if (dismissedInMemory.has(projectId)) return true;
  try {
    return window.localStorage.getItem(dismissKey(projectId)) === "1";
  } catch {
    return false;
  }
}

const dismissListeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  dismissListeners.add(listener);
  return () => {
    dismissListeners.delete(listener);
  };
};
// In-memory fallback so "Not now" still hides the chip when storage throws.
const dismissedInMemory = new Set<string>();

export function writeChipDismissed(projectId: string): void {
  dismissedInMemory.add(projectId);
  try {
    window.localStorage.setItem(dismissKey(projectId), "1");
  } catch {
    // Not persisted: the chip returns on the next visit, which is harmless.
  }
  dismissListeners.forEach((l) => l());
}

export function ConnectedGuidedSetupWelcomeCard({
  projectName,
}: {
  projectName: string;
}) {
  const api = useGuidedSetup();
  if (!api) return null;
  return (
    <GuidedSetupWelcomeCard
      entry={api.entry}
      projectName={projectName}
      disabled={api.isOpen}
      onOpen={() => api.open("welcome")}
    />
  );
}

export function ConnectedGuidedSetupChip({ projectId }: { projectId: string }) {
  const api = useGuidedSetup();
  const messageCount = useAuiState((s) => s.thread.messages.length);
  // Server snapshot is "dismissed" so server and first client render agree.
  const dismissed = React.useSyncExternalStore(
    subscribeDismissed,
    () => readChipDismissed(projectId),
    () => true,
  );
  if (!api) return null;
  return (
    <GuidedSetupChip
      entry={api.entry}
      threadEmpty={messageCount === 0}
      dismissed={dismissed}
      disabled={api.isOpen}
      onOpen={() => api.open("chip")}
      onDismiss={() => {
        writeChipDismissed(projectId);
      }}
    />
  );
}
