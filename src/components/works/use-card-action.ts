"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useChatSend } from "@/components/commands/chat-send-context";
import { useWorkCardHost } from "@/components/works/work-card-host";
import {
  isSameOriginPath,
  type CardActionResult,
  type CardButton,
} from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";

export type CardActionDeps = {
  // Null outside the project chat.
  send: ((text: string) => Promise<void>) | null;
  navigate: (href: string) => void;
  openTab: (tab: "outputs" | "calendar") => void;
  // The card's own Server Action for a `server` button; undefined = not wired.
  server: (id: string) => Promise<CardActionResult> | undefined;
  refresh: () => void;
  announce: (message: string) => void;
  toastError: (message: string) => void;
};

export type CardActionOutcome = { error: string | null };

// The pure core of useCardAction. `guard` is a ref-like flag: a second tap
// while one action runs does nothing.
export async function runCardAction(
  button: CardButton,
  deps: CardActionDeps,
  guard: { current: boolean },
): Promise<CardActionOutcome> {
  if (guard.current) return { error: null };
  guard.current = true;
  try {
    const { action } = button;
    switch (action.kind) {
      case "send": {
        if (!deps.send) return { error: copyText("kit.failed") };
        await deps.send(action.text);
        return { error: null };
      }
      case "link": {
        // Defence in depth: normalizeButtons already dropped these.
        if (!isSameOriginPath(action.href)) {
          return { error: copyText("kit.failed") };
        }
        deps.navigate(action.href);
        return { error: null };
      }
      case "tab": {
        deps.openTab(action.tab);
        return { error: null };
      }
      case "server": {
        const pending = deps.server(action.id);
        if (!pending) return { error: copyText("kit.failed") };
        const result = await pending;
        if (!result.ok) {
          if (result.code === "STALE" || result.code === "CONFLICT") {
            deps.toastError(copyText("kit.stale"));
            deps.refresh();
            return { error: null };
          }
          return { error: result.message };
        }
        // A Server Action that revalidates already returned the new page in
        // the same response: refresh only when the step says it did not.
        if (result.refresh) deps.refresh();
        if (result.message) deps.announce(result.message);
        return { error: null };
      }
    }
  } catch {
    return { error: copyText("kit.failed") };
  } finally {
    guard.current = false;
  }
}

export function useCardAction(handlers: {
  server?: (id: string) => Promise<CardActionResult>;
}): {
  run: (button: CardButton) => void;
  busyId: string | null;
  error: string | null;
  clearError: () => void;
} {
  const guard = useRef(false);
  const router = useRouter();
  const send = useChatSend();
  const host = useWorkCardHost();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { server } = handlers;

  const run = useCallback(
    (button: CardButton) => {
      if (guard.current) return;
      setError(null);
      setBusyId(button.id);
      startTransition(async () => {
        const outcome = await runCardAction(
          button,
          {
            send,
            navigate: (href) => router.push(href),
            openTab: (tab) => host?.openTab(tab),
            server: (id) => server?.(id),
            refresh: () => router.refresh(),
            announce: (message) => host?.announce(message),
            toastError: (message) => {
              toast.error(message);
            },
          },
          guard,
        );
        startTransition(() => {
          setError(outcome.error);
          setBusyId(null);
        });
      });
    },
    [send, router, host, server],
  );

  const clearError = useCallback(() => setError(null), []);
  return { run, busyId, error, clearError };
}
