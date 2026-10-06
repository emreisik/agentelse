"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LineChart } from "lucide-react";

import { ReportExportButtons } from "@/components/search-reports/report-export-buttons";
import { SeoReportBody } from "@/components/search-reports/seo-report-body";
import type { SeoReportCardData } from "@/lib/seo/reports/card";
import { SEO_REPORT_COPY } from "@/lib/seo/reports/text";
import type { SeoReportView } from "@/lib/seo/reports/types";

// Sohbetteki "seo-report" kartı (SC-F5, docs/search-reports.md "Kart"). Kart
// yalnız rapora işaret eder; Google sayısı taşımaz. Ekrana yaklaşınca raporu
// no-store uçtan yükler, böylece Disconnect ya da "Delete stored data"
// sonrası rapor hemen kaybolur. Sohbette kompakt görünür, "Show full report"
// ile tamamı açılır.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
  color: "var(--ws-text)",
} as const;
const MUTED = { color: "var(--ws-text-2)" } as const;
const FAINT = { color: "var(--ws-text-3)" } as const;

export type SeoReportCardState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; view: SeoReportView }
  | { state: "removed" }
  | { state: "error" };

function Skeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">Loading report…</span>
      <div className="grid grid-cols-3 gap-2" aria-hidden>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-14 animate-pulse rounded-xl"
            style={{ background: "var(--ws-hover)" }}
          />
        ))}
      </div>
      <div
        className="h-3 w-2/3 animate-pulse rounded"
        style={{ background: "var(--ws-hover)" }}
        aria-hidden
      />
    </div>
  );
}

function ReadyBody({ view }: { view: SeoReportView }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-3">
      <SeoReportBody view={view} compact={!expanded} />
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="text-xs font-medium underline-offset-2 hover:underline"
        style={MUTED}
      >
        {expanded ? "Hide full report" : "Show full report"}
      </button>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <ReportExportButtons view={view} />
        {view.searchHref ? (
          <Link
            href={view.searchHref}
            className="text-xs underline-offset-2 hover:underline"
            style={MUTED}
          >
            Open in Search
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function SeoReportCardView({
  card,
  state,
}: {
  card: SeoReportCardData;
  projectId: string;
  state: SeoReportCardState;
}) {
  const isMock = state.state === "ready" && state.view.isMock;
  return (
    <section
      aria-label={card.title}
      data-card="seo-report"
      data-state={state.state}
      className={`${CARD_CLASS} mt-1 w-full max-w-2xl space-y-3`}
      style={CARD_STYLE}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ws-hover)" }}
        >
          <LineChart className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-sm font-medium leading-snug">{card.title}</h3>
          <p className="text-xs" style={MUTED}>
            {card.periodLabel}
          </p>
        </div>
        {isMock ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {SEO_REPORT_COPY.sampleBadge}
          </span>
        ) : null}
      </div>
      {state.state === "ready" ? (
        <ReadyBody view={state.view} />
      ) : state.state === "removed" ? (
        <p className="text-xs" style={FAINT}>
          {SEO_REPORT_COPY.removed} Search Console was disconnected or its
          stored data was deleted.
        </p>
      ) : state.state === "error" ? (
        <p className="text-xs" style={FAINT} role="alert">
          The report could not be loaded.
        </p>
      ) : (
        <Skeleton />
      )}
    </section>
  );
}

export function SeoReportCard({
  card,
  projectId,
  commandId,
}: {
  card: SeoReportCardData;
  projectId: string;
  commandId?: string;
}) {
  const [state, setState] = useState<SeoReportCardState>({ state: "idle" });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = async () => {
      if (started) return;
      started = true;
      setState({ state: "loading" });
      try {
        const response = await fetch(
          `/api/projects/${projectId}/search/reports/${card.reportId}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 404) {
          setState({ state: "removed" });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { report?: SeoReportView };
        if (!body.report) throw new Error("empty");
        setState({ state: "ready", view: body.report });
      } catch {
        if (controller.signal.aborted) return;
        setState({ state: "error" });
      }
    };

    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      void load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [projectId, card.reportId]);

  return (
    <div ref={ref} data-card-id={commandId}>
      <SeoReportCardView card={card} projectId={projectId} state={state} />
    </div>
  );
}
