import { notFound } from "next/navigation";

import { PrintButton } from "@/components/report-share/print-button";
import { WhiteLabelFrame } from "@/components/report-share/white-label-frame";
import { SeoReportBody } from "@/components/search-reports/seo-report-body";
import { assetUrl } from "@/lib/asset-url";
import { reportShareOn } from "@/lib/report-share/flags";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { ReportBrandings } from "@/server/report-share/branding";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { readSeoReportView } from "@/server/seo/reports/store";

// Müşteri raporunun yönetici yazdırma sayfası (SC-F9): "Print / Save as PDF"
// tarayıcının PDF'e kaydetmesidir. Yalnız workspace OWNER/ADMIN; marka CANLI
// ayardan gelir (paylaşım bağlantıları ise oluşturma anındaki anlık
// görüntüyü kullanır). Kapalıyken, yetki yokken ya da rapor yokken notFound.

export default async function SearchClientReportPage({
  params,
}: {
  params: Promise<{ projectId: string; reportId: string }>;
}) {
  const { projectId, reportId } = await params;
  if (!reportShareOn() || !seoReportsActiveFor(projectId)) notFound();

  const { userId } = await requireUser();
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireProjectAccess(userId, projectId));
  } catch {
    notFound();
  }
  if (!(await isWorkspaceManager(userId, workspaceId))) notFound();

  const [view, branding] = await Promise.all([
    readSeoReportView(projectId, reportId),
    ReportBrandings.get(workspaceId),
  ]);
  // Nabız kartı müşteri raporu değildir.
  if (!view || view.kind === "PULSE") notFound();

  return (
    <WhiteLabelFrame
      branding={branding}
      title={view.title}
      periodLabel={view.snapshot.period.label}
      logoSrc={
        branding.logoAssetId ? assetUrl(branding.logoAssetId, "card") : null
      }
      printable
    >
      <div className="mb-4 print:hidden">
        <PrintButton />
      </div>
      <SeoReportBody
        view={{ ...view, findingStatus: null, contentPlanLive: false }}
      />
    </WhiteLabelFrame>
  );
}
