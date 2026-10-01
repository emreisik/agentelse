"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Coins, RefreshCw } from "lucide-react";

import { OPENAI_CREDIT_REFRESH_EVENT } from "@/lib/openai-credit-events";
import type { OpenAiCredit } from "@/server/billing/openai-credit";

const POLL_MS = 10_000;
// How long the "−$0.012" chip stays after the balance moves.
const DELTA_MS = 6_000;
// Below this a change is rounding noise, not spend.
const MIN_DELTA = 0.0005;

const signed = (value: number) =>
  `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(3)}`;

// Header pill with the OpenAI API credit left. Server-rendered value first,
// then kept current three ways: a 10 s poll while the tab is visible, an
// immediate read when the tab comes back or when something that just spent
// money asks for one (openai-credit-events.ts), and the refresh button. Polls
// the same kind of lightweight JSON route as ActiveWorkPopover.
//
// A chat turn costs about a cent, so the value shows three decimals and every
// change flashes its delta — a move you can't see reads as "not updating".
export function OpenAiCreditPill({ initial }: { initial: OpenAiCredit }) {
  const [credit, setCredit] = useState(initial);
  const [delta, setDelta] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const lastBalance = useRef(initial.balance);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    if (showSpinner) setPending(true);
    try {
      // A read already running may have started before the spend that
      // prompted a later request, so go again while any piled up behind it.
      do {
        queued.current = false;
        try {
          const res = await fetch("/api/openai-credit", { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as { credit: OpenAiCredit | null };
          const next = data.credit;
          if (next) {
            const moved = next.balance - lastBalance.current;
            lastBalance.current = next.balance;
            setCredit(next);
            if (Math.abs(moved) >= MIN_DELTA) {
              setDelta(moved);
              if (deltaTimer.current) clearTimeout(deltaTimer.current);
              deltaTimer.current = setTimeout(() => setDelta(null), DELTA_MS);
            }
          }
          setStale(false);
        } catch (error) {
          // Keep the last known value on screen, but say it may be behind —
          // and leave a trace, since this is otherwise invisible.
          console.warn("[openai-credit] refresh failed", error);
          setStale(true);
        }
      } while (queued.current);
    } finally {
      inFlight.current = false;
      if (showSpinner) setPending(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => void load(false), POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void load(false);
        start();
      }
    };
    const onRefreshRequest = () => void load(false);

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(OPENAI_CREDIT_REFRESH_EVENT, onRefreshRequest);
    return () => {
      stop();
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(OPENAI_CREDIT_REFRESH_EVENT, onRefreshRequest);
    };
  }, [load]);

  // The estimate is snapshot minus recorded spend; once spend passes the
  // snapshot the floor of $0 is an artefact, not a balance.
  const exhausted = credit.spent >= credit.snapshot;
  const amount = `$${credit.balance.toFixed(3)}`;
  const title = exhausted
    ? `Recorded spend ($${credit.spent.toFixed(3)} since ${credit.asOf.slice(0, 10)}) has passed the last balance snapshot ($${credit.snapshot.toFixed(2)}). ` +
      "Set OPENAI_CREDIT_BALANCE and OPENAI_CREDIT_BALANCE_AS_OF to today's balance from the OpenAI dashboard."
    : `Estimated OpenAI API credit: $${credit.spent.toFixed(4)} spent by this app since ${credit.asOf.slice(0, 10)} from a $${credit.snapshot.toFixed(2)} snapshot. ` +
      "OpenAI has no balance API, so this can drift from the dashboard." +
      (stale ? " Last refresh failed — value may be behind." : "");

  return (
    <div
      title={title}
      aria-label={`Estimated OpenAI API credit balance: ${amount}${exhausted ? " (snapshot out of date)" : ""}`}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border pr-1 pl-3 text-xs font-semibold tabular-nums whitespace-nowrap"
      style={{
        borderColor: exhausted ? "var(--ws-pending)" : "var(--ws-border)",
        color: "var(--ws-text)",
        opacity: stale ? 0.6 : 1,
      }}
    >
      <Coins
        className="size-4 shrink-0"
        style={exhausted ? { color: "var(--ws-pending)" } : undefined}
      />
      <span className="hidden sm:inline" style={{ color: "var(--ws-text-3)" }}>
        {exhausted ? "re-sync" : "OpenAI"}
      </span>
      {amount}
      {delta !== null ? (
        <span
          aria-hidden
          className="font-medium"
          style={{
            color: delta < 0 ? "var(--ws-text-3)" : "var(--ws-approved)",
          }}
        >
          {signed(delta)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void load(true)}
        disabled={pending}
        aria-label="Refresh OpenAI credit"
        title="Refresh"
        className="flex size-6 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-60"
        style={{ color: "var(--ws-text-2)" }}
      >
        <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}
