import { notFound } from "next/navigation";

import { assetUrl } from "@/lib/asset-url";
import { prisma } from "@/lib/prisma";
import { reportShareOn } from "@/lib/report-share/flags";
import { websiteCardToDocument } from "@/lib/website-analytics/agency/client-report/convert";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { GaFlags } from "@/lib/website-analytics/flags";
import { PrintButton } from "@/components/report-share/print-button";
import { WhiteLabelFrame } from "@/components/report-share/white-label-frame";
import { ClientReportView } from "@/components/website-analytics/agency/client-report-view";
import { ReportBrandings } from "@/server/report-share/branding";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  loadWebsiteReportForClient,
  WEBSITE_SHARE_FOOTER_FALLBACK,
} from "@/server/website-analytics/agency/share";

// GA-F8 white-label: müşteri raporunun yönetici yazdırma sayfası
// ("Print / PDF" = tarayıcının PDF'e kaydetmesi). Yalnız workspace
// OWNER/ADMIN; marka canlı ayardan gelir, belge saklı karttan kurulur.
// Kapalıyken, yetki yokken ya da kart bulunamadığında hep notFound.

export default async function ClientReportPrintPage({
  params,
}: {
  params: Promise<{ projectId: string; commandId: string }>;
}) {
  const { projectId, commandId } = await params;
  if (
    !GaFlags.websitePage() ||
    !gaAgencyEnabledFor(projectId) ||
    !reportShareOn()
  ) {
    notFound();
  }

  const { userId } = await requireUser();
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireProjectAccess(userId, projectId));
  } catch {
    notFound();
  }
  if (!(await isWorkspaceManager(userId, workspaceId))) notFound();

  const card = await loadWebsiteReportForClient({
    projectId,
    commandId,
    allowPlan: true,
  });
  if (!card) notFound();

  const [project, live] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    ReportBrandings.get(workspaceId),
  ]);
  const branding = {
    ...live,
    footer: live.footer?.trim() ? live.footer : WEBSITE_SHARE_FOOTER_FALLBACK,
  };
  const doc = websiteCardToDocument(card, {
    clientName: project?.name ?? "",
    agencyName: branding.displayName,
    forShare: false,
  });
  if (!doc) notFound();

  return (
    <WhiteLabelFrame
      branding={branding}
      title={doc.title}
      periodLabel={doc.periodLabel}
      logoSrc={branding.logoAssetId ? assetUrl(branding.logoAssetId, "card") : null}
      printable
    >
      <div className="mb-4 print:hidden">
        <PrintButton />
      </div>
      <ClientReportView doc={doc} />
    </WhiteLabelFrame>
  );
}
