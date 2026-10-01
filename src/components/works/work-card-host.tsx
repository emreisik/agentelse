"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { ChannelKey } from "@/lib/content-channels";
import type { NextStep } from "@/lib/journey";
import { copyText } from "@/lib/works/copy";

// What a card needs to know about the Work it sits in. Provided by the chat
// only when a Work is on screen: null (no provider) means Works is off and
// every card falls back to today's behaviour.
export type WorkCardHostValue = {
  projectId: string;
  workId: string;
  workTitle: string;
  active: boolean;
  // A chat turn is streaming.
  busy: boolean;
  // Plan Command ids with a running production.
  producing: ReadonlySet<string>;
  timezone?: string;
  channels: { key: ChannelKey; label: string; connected: boolean }[];
  // Channels the PROJECT has connected, independent of the Work's own channel
  // list: a held piece may belong to a channel the Work no longer covers.
  connectedChannels?: readonly ChannelKey[];
  openTab: (tab: "outputs" | "calendar") => void;
  runNextStep: (step: NextStep) => void;
  // Speaks a message in the ONE live region below; survives a card replacement.
  announce: (message: string) => void;
  // A card that replaces itself asks for focus first; the new card consumes it.
  requestFocus: (commandId: string) => void;
  // Drops a request whose action failed, so a later card does not steal focus.
  cancelFocus: (commandId: string) => void;
  consumeFocus: (commandId: string) => boolean;
};

// What the chat supplies; the provider owns the other three.
export type WorkCardHostInput = Omit<
  WorkCardHostValue,
  "announce" | "requestFocus" | "cancelFocus" | "consumeFocus"
>;

// The provider's own state, kept outside React so announce and focus requests
// never depend on a card that a refresh is about to replace.
export type HostRegistry = {
  announce: (message: string | undefined | null) => void;
  requestFocus: (commandId: string) => void;
  cancelFocus: (commandId: string) => void;
  consumeFocus: (commandId: string) => boolean;
  getMessage: () => string;
  subscribe: (listener: () => void) => () => void;
};

export function normalizeAnnouncement(
  message: string | undefined | null,
): string {
  const text = message?.trim();
  return text ? text : copyText("a11y.cardUpdated");
}

export function createHostRegistry(): HostRegistry {
  let message = "";
  const listeners = new Set<() => void>();
  const focus = new Set<string>();
  return {
    announce(next) {
      const text = normalizeAnnouncement(next);
      // A live region only speaks a CHANGE: the same text twice in a row gets
      // a trailing no-break space so it is read again.
      message = text === message ? `${text}\u00a0` : text;
      for (const listener of [...listeners]) listener();
    },
    requestFocus(commandId) {
      focus.add(commandId);
    },
    cancelFocus(commandId) {
      focus.delete(commandId);
    },
    consumeFocus(commandId) {
      return focus.delete(commandId);
    },
    getMessage: () => message,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const WorkCardHostContext = createContext<WorkCardHostValue | null>(null);

// A leaf of its own so an announcement re-renders only this region, not the
// provider's subtree.
function HostLiveRegion({ registry }: { registry: HostRegistry }) {
  const message = useSyncExternalStore(
    registry.subscribe,
    registry.getMessage,
    registry.getMessage,
  );
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}

export function WorkCardHostProvider({
  value,
  children,
}: {
  value: WorkCardHostInput;
  children?: React.ReactNode;
}) {
  const [registry] = useState(createHostRegistry);
  const merged = useMemo<WorkCardHostValue>(
    () => ({
      ...value,
      announce: registry.announce,
      requestFocus: registry.requestFocus,
      cancelFocus: registry.cancelFocus,
      consumeFocus: registry.consumeFocus,
    }),
    [value, registry],
  );
  return (
    <WorkCardHostContext.Provider value={merged}>
      {children}
      {/* One persistent region: a card's own region would be destroyed by the
          refresh that replaces the card, before it is read. */}
      <HostLiveRegion registry={registry} />
    </WorkCardHostContext.Provider>
  );
}

export function useWorkCardHost(): WorkCardHostValue | null {
  return useContext(WorkCardHostContext);
}

type HostGatedAction = {
  kind: "send" | "server" | "link" | "tab";
  planId?: string;
};

// Why a button cannot be used right now, or null. Only what would change
// something is blocked: links and tabs stay usable in a Completed Work, and a
// streaming reply blocks only the actions that would start another turn.
export function disabledReasonOf(
  host: WorkCardHostValue | null,
  action: HostGatedAction,
): string | null {
  if (!host) return null;
  const changes = action.kind === "send" || action.kind === "server";
  if (!host.active && changes) return copyText("kit.workDone");
  if (host.busy && action.kind === "send") return copyText("kit.chatBusy");
  if (
    action.kind === "server" &&
    action.planId !== undefined &&
    host.producing.has(action.planId)
  ) {
    return copyText("kit.reasonRun");
  }
  return null;
}
