import Link from "next/link";

import { cn } from "@/lib/utils";
import { ReportExportButtons } from "@/components/search-reports/report-export-buttons";
import { SeoGoalsCard } from "@/components/search-reports/seo-goals-card";
import { SeoReportBody } from "@/components/search-reports/seo-report-body";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { SEO_REPORT_COPY } from "@/lib/seo/reports/text";
import type {
  SeoReportKind,
  SeoReportListItem,
  SeoReportView,
} from "@/lib/seo/reports/types";
import { seoChatHref } from "@/server/seo/reports/chat";
import { listSeoGoals } from "@/server/seo/reports/goals";
import { listSeoReports, readSeoReportView } from "@/server/seo/reports/store";

// Search sayfasındaki "Reports & goals" bölümü (SC-F5, docs/search-reports.md):
// arşiv (Weekly, Monthly, Roadmap, son 14 günün nabızları), seçili raporun
// tamamı + dışa aktarma, "Ask why search traffic changed" bağlantısı ve SEO
// hedefleri kartı. Bayrak ve izin listesi okumadan önce ortamdan sınanır;
// kapalıyken hiçbir şey çizilmez ve veritabanına dokunulmaz. Okuma hataları
// bölümü düşürmez, sayfanın geri kalanı etkilenmez.

const GROUPS: readonly { kind: SeoReportKind; title: string }[] = [
  { kind: "WEEKLY", title: "Weekly" },
  { kind: "MONTHLY", title: "Monthly" },
  { kind: "ROADMAP", title: "Roadmap" },
  { kind: "PULSE", title: "Pulse" },
];

function Archive({
  items,
  selectedId,
}: {
  items: SeoReportListItem[];
  selectedId: string | null;
}) {
  return (
    <nav aria-label="Report archive" className="space-y-3">
      {GROUPS.map((group) => {
        const rows = items.filter((item) => item.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <div key={group.kind} className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
              {group.kind === "PULSE" ? " (last 14 days)" : ""}
            </p>
            <ul className="space-y-0.5">
              {rows.map((item) => {
                const active = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <Link
                      href={`?report=${encodeURIComponent(item.id)}#reports`}
                      scroll={false}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-sm transition-colors",
                        active
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{item.periodLabel}</span>
                      {item.isMock ? (
                        <span className="shrink-0 text-[10px] uppercase">
                          {SEO_REPORT_COPY.sampleBadge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export async function SearchReportsSection({
  projectId,
  reportId,
}: {
  projectId: string;
  reportId?: string | null;
}): Promise<React.JSX.Element | null> {
  if (!seoReportsActiveFor(projectId)) return null;

  const [items, goals, chatHref, explicit] = await Promise.all([
    listSeoReports(projectId, { limit: 40 }).catch(
      (): SeoReportListItem[] => [],
    ),
    listSeoGoals(projectId).catch(() => []),
    seoChatHref(projectId).catch(() => null),
    reportId
      ? readSeoReportView(projectId, reportId).catch(() => null)
      : Promise.resolve<SeoReportView | null>(null),
  ]);

  // Adresteki rapor yoksa (silinmiş ya da başka mod) ilk haftalık/aylık/yol
  // haritası raporuna düşülür.
  let view = explicit;
  if (!view) {
    const first = items.find((item) => item.kind !== "PULSE");
    if (first) {
      view = await readSeoReportView(projectId, first.id).catch(() => null);
    }
  }

  return (
    <section
      id="reports"
      aria-labelledby="seo-reports-title"
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <div className="space-y-1">
        <h2 id="seo-reports-title" className="text-base font-semibold">
          Reports &amp; goals
        </h2>
        <p className="text-sm text-muted-foreground">
          Weekly on Wednesday, monthly on the 4th. Built only from final Search
          Console data.
        </p>
        {chatHref ? (
          <Link
            href={chatHref}
            className="inline-block text-sm underline underline-offset-2"
          >
            Ask why search traffic changed
          </Link>
        ) : null}
      </div>

      {items.length === 0 && !view ? (
        <p className="rounded-xl p-4 text-sm text-muted-foreground ring-1 ring-foreground/10">
          Your first weekly SEO report arrives on Wednesday after Google
          finalizes last week&apos;s data.
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
          <Archive items={items} selectedId={view?.id ?? null} />
          {view ? (
            <article
              data-report={view.id}
              className="min-w-0 space-y-3 rounded-xl p-4 ring-1 ring-foreground/10"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <h3 className="text-sm font-semibold">{view.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {view.snapshot.period.label} · {view.snapshot.site.label}
                    {view.isMock ? ` · ${SEO_REPORT_COPY.sampleBadge}` : ""}
                  </p>
                </div>
                <ReportExportButtons view={view} />
              </header>
              <SeoReportBody view={view} />
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">
              This report is no longer stored.
            </p>
          )}
        </div>
      )}

      <SeoGoalsCard projectId={projectId} goals={goals} />
    </section>
  );
}
