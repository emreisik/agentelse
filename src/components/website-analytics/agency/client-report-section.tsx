import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { reportShareOn } from "@/lib/report-share/flags";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import type { WebsiteReportArchiveItem } from "@/lib/website-analytics/reports/types";
import { ReportBrandings } from "@/server/report-share/branding";
import { listWebsiteReportShares } from "@/server/website-analytics/agency/share";

import { SharePanel } from "./share-link-panel";

// Website sayfasındaki "Client reports" bölümü (GA-F8 white-label): seçili
// mülkün haftalık/aylık/plan kartları için marka adıyla Markdown dışa aktarma,
// yazdırma sayfası ve (plan hariç) müşteri bağlantıları. Yalnız workspace
// OWNER/ADMIN görür; bayrak kapalıyken ya da bu mülkün kartı yokken hiçbir
// şey çizilmez. Paylaşımlar tek sorguyla yüklenir.

const VARIANT_LABEL: Record<WebsiteReportArchiveItem["variant"], string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  plan: "Plan",
};

const LINK_CLASS =
  "inline-flex h-6 items-center rounded-lg px-2 text-xs font-medium hover:bg-muted";

export async function ClientReportSection({
  projectId,
  linkId,
  items,
  canManage,
}: {
  projectId: string;
  linkId: string;
  items: WebsiteReportArchiveItem[];
  canManage: boolean;
}) {
  if (!canManage || !gaAgencyEnabledFor(projectId) || !reportShareOn()) {
    return null;
  }
  const mine = items.filter((item) => item.card.linkId === linkId);
  if (mine.length === 0) return null;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) return null;
  const shareable = mine
    .filter((item) => item.variant !== "plan")
    .map((item) => item.commandId);
  const [branding, shares] = await Promise.all([
    ReportBrandings.get(project.workspaceId),
    listWebsiteReportShares(projectId, shareable),
  ]);

  return (
    <section
      id="client-reports"
      aria-labelledby="client-reports-title"
      className="space-y-3"
    >
      <div className="space-y-0.5">
        <h2 id="client-reports-title" className="text-sm font-medium">
          Client reports
        </h2>
        <p className="text-xs text-muted-foreground">
          Uses {branding.displayName} branding.{" "}
          <Link
            href="/websites#branding"
            className="underline underline-offset-2"
          >
            Edit it in Websites.
          </Link>
        </p>
      </div>
      <ul className="divide-y divide-foreground/5 rounded-xl ring-1 ring-foreground/10">
        {mine.map((item) => (
          <li key={item.commandId} className="space-y-3 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {VARIANT_LABEL[item.variant]}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {item.title}
                  </span>
                  {item.card.isMock ? (
                    <span className="text-[10px] text-muted-foreground">
                      Demo data
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.periodLabel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <a
                  href={`/api/projects/${projectId}/client-report?command=${encodeURIComponent(item.commandId)}&format=md`}
                  className={LINK_CLASS}
                >
                  Markdown
                </a>
                <Link
                  href={`/projects/${projectId}/site/client/${encodeURIComponent(item.commandId)}`}
                  target="_blank"
                  className={LINK_CLASS}
                >
                  Print / PDF
                </Link>
              </div>
            </div>
            {item.variant !== "plan" ? (
              <SharePanel
                projectId={projectId}
                commandId={item.commandId}
                shares={shares[item.commandId] ?? []}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
