import { NextResponse } from "next/server";

import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { readSeoReportView } from "@/server/seo/reports/store";

// Sohbetteki "seo-report" kartı raporu bu uçtan tembel yükler (SC-F5,
// docs/search-reports.md). Kart yalnız rapora işaret eder; sayılar burada
// saklı anlık görüntüden okunur. Disconnect ya da "Delete stored data"
// sonrası rapor hemen kaybolsun diye HER yanıt önbelleğe alınmaz.

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: NO_STORE },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; reportId: string }> },
) {
  const { projectId, reportId } = await params;

  // Bayrak ve izin listesi yalnız ortamdan okunur: kapalıyken veritabanına
  // hiç dokunulmaz.
  if (!seoReportsActiveFor(projectId)) return notFound();

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) return notFound();
    throw error;
  }

  const report = await readSeoReportView(projectId, reportId);
  if (!report) return notFound();
  return NextResponse.json({ report }, { headers: NO_STORE });
}
