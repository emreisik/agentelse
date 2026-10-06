import Link from "next/link";

import { ReportExportButtons } from "@/components/website-analytics/reports/report-export-buttons";
import { formatBuiltAt } from "@/lib/module-flows/analytics/format";
import { WEBSITE_REPORT_COPY } from "@/lib/website-analytics/reports/copy";
import { reportHrefs } from "@/lib/website-analytics/reports/ids";
import type { WebsiteReportArchiveItem } from "@/lib/website-analytics/reports/types";

// Website sayfasındaki "Reports" arşivi (GA-F5): Website analytics sohbetinden
// en yeni haftalık, aylık ve plan kartları; her biri sohbette açılır ve
// dışa aktarılır. Sunucuda çizilir; yalnız dışa aktarma düğmeleri istemcidir.

const VARIANT_LABEL: Record<WebsiteReportArchiveItem["variant"], string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  plan: "Plan",
};

export function WebsiteReportArchive({
  projectId,
  items,
}: {
  projectId: string;
  items: WebsiteReportArchiveItem[];
}) {
  return (
    <section
      id="reports"
      aria-labelledby="reports-title"
      data-project={projectId}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="reports-title" className="text-sm font-medium">
          Reports
        </h2>
        <Link
          href={reportHrefs(projectId, true).settings}
          className="text-xs text-muted-foreground underline underline-offset-2"
        >
          Report settings
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl p-4 text-sm text-muted-foreground ring-1 ring-foreground/10">
          {WEBSITE_REPORT_COPY.archiveEmpty}
        </p>
      ) : (
        <ul className="divide-y divide-foreground/5 rounded-xl ring-1 ring-foreground/10">
          {items.map((item) => (
            <li
              key={item.commandId}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {VARIANT_LABEL[item.variant]}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {item.title}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.periodLabel} · Sent{" "}
                  {formatBuiltAt(item.builtAt, item.card.timeZone)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Link
                  href={item.chatHref}
                  className="inline-flex h-6 items-center rounded-lg px-2 text-xs font-medium hover:bg-muted"
                >
                  Open in chat
                </Link>
                <ReportExportButtons card={item.card} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
