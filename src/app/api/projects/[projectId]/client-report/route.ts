import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { websiteCardToDocument } from "@/lib/website-analytics/agency/client-report/convert";
import {
  buildClientDocMarkdown,
  clientDocFileName,
} from "@/lib/website-analytics/agency/client-report/markdown";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { reportShareOn } from "@/lib/report-share/flags";
import { ReportBrandings } from "@/server/report-share/branding";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  loadWebsiteReportForClient,
  WEBSITE_SHARE_FOOTER_FALLBACK,
} from "@/server/website-analytics/agency/share";

// GA-F8 white-label: müşteri raporunun Markdown dışa aktarması (yalnız
// workspace OWNER/ADMIN). Belge saklı karttan kurulur, marka canlı ayardan
// gelir. Kapalıyken, yetki yokken ya da kart bulunamadığında hepsi aynı 404.
// Yanıt kullanıcıya özeldir ve önbelleğe alınmaz.

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: NO_STORE },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  // Bayrak ve izin listesi yalnız ortamdan okunur: kapalıyken veritabanına
  // hiç dokunulmaz.
  if (!gaAgencyEnabledFor(projectId) || !reportShareOn()) return notFound();

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  let workspaceId: string;
  try {
    ({ workspaceId } = await requireProjectAccess(userId, projectId));
  } catch (error) {
    if (isAgentelseError(error)) return notFound();
    throw error;
  }
  if (!(await isWorkspaceManager(userId, workspaceId))) return notFound();

  const url = new URL(request.url);
  if (url.searchParams.get("format") !== "md") return notFound();
  const commandId = url.searchParams.get("command") ?? "";
  if (!commandId) return notFound();

  const card = await loadWebsiteReportForClient({
    projectId,
    commandId,
    allowPlan: true,
  });
  if (!card) return notFound();

  const [project, branding] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    ReportBrandings.get(workspaceId),
  ]);
  const doc = websiteCardToDocument(card, {
    clientName: project?.name ?? "",
    agencyName: branding.displayName,
    forShare: false,
  });
  if (!doc) return notFound();

  const markdown = buildClientDocMarkdown(doc, {
    displayName: branding.displayName,
    footer: branding.footer?.trim() ? branding.footer : WEBSITE_SHARE_FOOTER_FALLBACK,
  });

  // Yalnız kimlikler ve çeşit; hiçbir sayı ya da metin yazılmaz.
  await AuditLogRepository.record({
    workspaceId,
    projectId,
    actorType: "USER",
    actorId: userId,
    action: "ga_client_report.exported",
    entityType: "Command",
    entityId: commandId,
    metadata: { variant: card.variant, format: "md" },
  });

  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${clientDocFileName(doc, "md")}"`,
      ...NO_STORE,
    },
  });
}
