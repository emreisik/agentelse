"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone } from "lucide-react";

import { CardTitle } from "@/components/workspace/card-title";
import { timeAgo } from "@/lib/dates";
import type { AdsOverview } from "@/server/ads/overview";

// Sağ dokun Brand sekmesindeki "Ads" kartı (docs/meta-ads-plan.md K22, F6):
// son 7 gün, çalışan kampanya, acil uyarı ve tazelik. Aynadan okunur, sayfa
// çizildikten sonra kendi ucundan; ayna kapalıysa kart görünmez.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

export type AdsOverviewState = { status: "loading" } | { status: "done"; overview: AdsOverview };

function useAdsOverview(projectId: string): AdsOverviewState {
  const [state, setState] = useState<AdsOverviewState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/ads/overview`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({ status: "done", overview: (await res.json()) as AdsOverview });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "done", overview: { ok: false, reason: "off" } });
      }
    })();
    return () => controller.abort();
  }, [projectId]);
  return state;
}

export function AdsOverviewCard({ projectId }: { projectId: string }) {
  return <AdsOverviewView projectId={projectId} state={useAdsOverview(projectId)} />;
}

export function AdsOverviewView({
  projectId,
  state,
}: {
  projectId: string;
  state: AdsOverviewState;
}) {
  if (state.status === "loading" || !state.overview.ok) return null;
  const overview = state.overview;
  return (
    <section aria-label="Meta Ads" data-card="ads-overview" className={CARD_CLASS} style={CARD_STYLE}>
      <CardTitle
        icon={<Megaphone className="size-4" aria-hidden />}
        aside={
          <Link
            href={`/projects/${projectId}/ads`}
            className="text-[11px] underline-offset-2 hover:underline"
            style={{ color: "var(--ws-text-2)" }}
          >
            Open
          </Link>
        }
      >
        Meta Ads
      </CardTitle>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <dd className="truncate text-sm font-semibold tabular-nums" style={{ color: "var(--ws-text)" }}>
            {overview.spend}
          </dd>
          <dt className="truncate text-[10px]" style={{ color: "var(--ws-text-3)" }}>
            Spent, 7 days
          </dt>
        </div>
        <div className="min-w-0">
          <dd className="truncate text-sm font-semibold tabular-nums" style={{ color: "var(--ws-text)" }}>
            {overview.results ?? "—"}
          </dd>
          <dt className="truncate text-[10px]" style={{ color: "var(--ws-text-3)" }}>
            {overview.resultLabel ?? "Results"}
          </dt>
        </div>
        <div className="min-w-0">
          <dd className="truncate text-sm font-semibold tabular-nums" style={{ color: "var(--ws-text)" }}>
            {overview.costPerResult ?? "—"}
          </dd>
          <dt className="truncate text-[10px]" style={{ color: "var(--ws-text-3)" }}>
            Each
          </dt>
        </div>
      </dl>
      <p className="mt-2.5 text-[11px] leading-snug" style={{ color: "var(--ws-text-2)" }}>
        {overview.running} campaign{overview.running === 1 ? "" : "s"} running
        {overview.urgent > 0 ? ` · ${overview.urgent} need${overview.urgent === 1 ? "s" : ""} attention` : ""}
        {overview.updatedAt ? ` · Updated ${timeAgo(overview.updatedAt)}` : ""}
      </p>
    </section>
  );
}
