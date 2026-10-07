import { prisma } from "@/lib/prisma";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { parseBrandingSnapshot } from "@/lib/report-share/branding";
import { reportShareOn } from "@/lib/report-share/flags";
import { isLogoMime } from "@/lib/report-share/types";
import { ReportShares } from "@/server/report-share/store";
import { readAsset } from "@/server/storage/asset-storage";

// Herkese açık rapor sayfasının logosu (SC-F9 ve GA-F8 ortak). Genel sayfa
// görseli yalnız buradan alır (imzalı varlık adresi ya da data URI yok). Aynı
// bağlantı doğrulaması ve bayrak kontrolü uygulanır; yalnız bu workspace'in
// LOGO türündeki png/jpeg/webp dosyaları sunulur, SVG asla. Başka her durum
// aynı gövdeyle 404. GET işleyicisi Request okuduğu için dinamiktir.

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (isRateLimited(`report-share:${getClientIp(request)}`, 60, 60_000)) {
    return notFoundResponse();
  }
  if (!reportShareOn()) return notFoundResponse();

  const resolved = await ReportShares.resolve(token);
  if (!resolved.ok) return notFoundResponse();
  const { share } = resolved;
  const branding = parseBrandingSnapshot(share.branding, "");
  if (!branding.logoAssetId) return notFoundResponse();

  const asset = await prisma.asset.findFirst({
    where: {
      id: branding.logoAssetId,
      workspaceId: share.workspaceId,
      type: "LOGO",
    },
    select: { storageKey: true, mimeType: true },
  });
  if (!asset || !isLogoMime(asset.mimeType)) return notFoundResponse();

  let file: Buffer;
  try {
    file = await readAsset(asset.storageKey);
  } catch {
    return notFoundResponse();
  }
  return new Response(new Uint8Array(file), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
