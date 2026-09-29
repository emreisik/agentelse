"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronDown, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { IdeaEventCard } from "@/components/commands/idea-event-card";
import type { PendingDecision } from "@/server/agency/pending-decisions";

// The Agency Desk's single decision point (replaces the old Approval
// Center page/panel): a slim bar above the conversation that says how
// many decisions are waiting, and opens them as the same chat cards over
// the thread. Deciding a card calls router.refresh() (see
// ApprovalRequestCard / CreativeCard), so the page re-fetches
// getPendingDecisions and the decided item drops out on its own.
// `?decisions=open` (top bar count, dashboard) lands with it expanded.
export function DecisionsBar({ decisions }: { decisions: PendingDecision[] }) {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(
    () => searchParams.get("decisions") === "open",
  );

  // Nothing left → collapse, so the next decision arrives as a quiet bar
  // instead of a panel that pops back open by itself. Adjusted during
  // render (React's "storing info from previous renders" pattern), not in
  // an effect.
  const [prevCount, setPrevCount] = useState(decisions.length);
  if (prevCount !== decisions.length) {
    setPrevCount(decisions.length);
    if (decisions.length === 0) setOpen(false);
  }

  if (decisions.length === 0) return null;

  // Spend first (the one that must never be missed), then publishes,
  // then creatives/other — oldest first within each group.
  const sorted = [...decisions].sort((a, b) => rank(a) - rank(b));
  const spend = decisions.filter(
    (d) => d.card.kind === "approval-request" && d.card.category === "spend",
  ).length;
  const creatives = decisions.filter(
    (d) => d.card.kind === "creative-ready",
  ).length;
  const other = decisions.length - spend - creatives;
  const summary = [
    spend ? `${spend} spend` : null,
    creatives
      ? `${creatives} ${creatives === 1 ? "creative" : "creatives"}`
      : null,
    other ? `${other} ${other === 1 ? "action" : "actions"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const thumbs = decisions
    .flatMap((d) =>
      d.card.kind === "creative-ready" && d.card.assetId
        ? [{ id: d.approvalId, assetId: d.card.assetId }]
        : [],
    )
    .slice(0, 3);

  return (
    <div className="relative z-20 shrink-0 px-4 pt-3">
      <div className="mx-auto w-full max-w-(--thread-max-width)">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--ws-hover)]"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface)",
            boxShadow: "var(--ws-card-shadow)",
          }}
        >
          <span className="relative flex size-2.5 shrink-0">
            <span
              className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
              style={{
                background: spend ? "var(--destructive)" : "var(--ws-pending)",
              }}
            />
            <span
              className="relative inline-flex size-2.5 rounded-full"
              style={{
                background: spend ? "var(--destructive)" : "var(--ws-pending)",
              }}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className="block text-sm font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {decisions.length}{" "}
              {decisions.length === 1 ? "decision" : "decisions"} waiting on you
            </span>
            <span
              className="block truncate text-xs"
              style={{ color: "var(--ws-text-3)" }}
            >
              {summary}
            </span>
          </span>
          {thumbs.length > 0 ? (
            <span className="hidden shrink-0 -space-x-2 sm:flex">
              {thumbs.map((t) => (
                // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
                <img
                  key={t.id}
                  src={`/api/assets/${t.assetId}`}
                  alt=""
                  className="size-8 rounded-lg border-2 object-cover"
                  style={{ borderColor: "var(--ws-surface)" }}
                />
              ))}
            </span>
          ) : null}
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              background: "var(--ws-accent)",
              color: "var(--ws-on-accent)",
            }}
          >
            {open ? "Hide" : "Review"}
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                open && "rotate-180",
              )}
            />
          </span>
        </button>

        {open ? (
          <div
            className="absolute inset-x-4 top-full mt-2 overflow-hidden rounded-2xl border"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-bg)",
              boxShadow: "0 24px 60px rgba(0,0,0,0.14)",
            }}
          >
            <div className="mx-auto w-full max-w-(--thread-max-width)">
              <div
                className="flex items-center justify-between gap-3 border-b px-4 py-2.5"
                style={{ borderColor: "var(--ws-border)" }}
              >
                <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
                  Decide here — everything else keeps running on its own.
                </p>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close decisions"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto p-4">
                {sorted.map((decision) => (
                  <IdeaEventCard
                    key={decision.approvalId}
                    card={decision.card}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function rank(decision: PendingDecision): number {
  const card = decision.card;
  if (card.kind === "approval-request") {
    if (card.category === "spend") return 0;
    if (card.category === "publish") return 1;
    return 3;
  }
  return 2;
}
