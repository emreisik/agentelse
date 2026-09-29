"use client";

import { useEffect, useState, useTransition } from "react";
import { Coins, RefreshCw } from "lucide-react";

import { refreshOpenAiCreditAction } from "@/server/actions/openai-credit-actions";
import type { OpenAiCredit } from "@/server/billing/openai-credit";

const AUTO_REFRESH_MS = 60_000;

// Header pill with the OpenAI API credit left. Server-rendered value first,
// then refreshed on the button and once a minute so spend shows up without
// a page reload.
export function OpenAiCreditPill({ initial }: { initial: OpenAiCredit }) {
  const [credit, setCredit] = useState(initial);
  const [pending, startRefresh] = useTransition();

  const refresh = () =>
    startRefresh(async () => {
      const next = await refreshOpenAiCreditAction();
      if (next) setCredit(next);
    });

  useEffect(() => {
    const id = setInterval(refresh, AUTO_REFRESH_MS);
    return () => clearInterval(id);
    // refresh only closes over stable state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const amount = `$${credit.balance.toFixed(2)}`;
  const title = `OpenAI API credit — ${credit.spent.toFixed(4)} USD spent since ${credit.asOf.slice(0, 10)}`;

  return (
    <div
      title={title}
      aria-label={`OpenAI API credit balance: ${amount}`}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border pr-1 pl-3 text-xs font-semibold tabular-nums whitespace-nowrap"
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
    >
      <Coins className="size-4 shrink-0" />
      <span className="hidden sm:inline" style={{ color: "var(--ws-text-3)" }}>
        OpenAI
      </span>
      {amount}
      <button
        type="button"
        onClick={refresh}
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
