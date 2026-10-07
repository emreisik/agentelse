import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { WhiteLabelFrame } from "@/components/report-share/white-label-frame";
import { isRateLimited, getClientIp } from "@/lib/rate-limit";
import { parseBrandingSnapshot } from "@/lib/report-share/branding";
import { reportShareOn } from "@/lib/report-share/flags";
import { isShareKind } from "@/lib/report-share/types";
import { ReportShares } from "@/server/report-share/store";
import "@/server/report-share/register-all";
import {
  shareRendererFor,
  type ShareRenderResult,
} from "@/server/report-share/renderers";

// Herkese açık, salt-okunur rapor bağlantısı (SC-F9 ve GA-F8 ortak). Oturum
// yok, AppShell yok, Agentelse markası yok. Tüm başarısızlıklar (bilinmeyen,
// yanlış gizli parça, süresi dolmuş, iptal, silinmiş rapor, çizici hatası,
// bayrak kapalı, hız sınırı) AYNI notFound() sonucunu verir; src/app/r/
// not-found.tsx nötr metni çizer. Sayfa headers() okuduğu için dinamiktir
// (önbelleğe alınmaz). Veritabanına yazan tek şey sınırlı görüntüleme
// sayacıdır. Kalan sınır: kök düzen varsayılan belge başlığı/simgesini
// verir; başlığı aşağıdaki metadata geçersiz kılar. Herkese açık okuma
// yolunda yerel izin listesi bekçisi yoktur.

export const metadata: Metadata = {
  title: "Report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ip = getClientIp(
    new Request("http://localhost", { headers: await headers() }),
  );
  if (isRateLimited(`report-share:${ip}`, 60, 60_000)) notFound();
  if (!reportShareOn()) notFound();

  const resolved = await ReportShares.resolve(token);
  if (!resolved.ok) notFound();
  const { share } = resolved;
  const renderer = isShareKind(share.kind) ? shareRendererFor(share.kind) : null;
  if (!renderer) notFound();

  const branding = parseBrandingSnapshot(share.branding, "");
  let rendered: ShareRenderResult | null = null;
  try {
    rendered = await renderer({
      projectId: share.projectId,
      reportId: share.reportId,
      branding,
    });
  } catch (error) {
    // Ayrıntı sızmasın: yalnız hata adı günlüğe yazılır.
    console.error(
      "[report-share] render failed:",
      error instanceof Error ? error.name : "error",
    );
    rendered = null;
  }
  if (!rendered) notFound();

  return (
    <WhiteLabelFrame
      branding={branding}
      title={rendered.title}
      periodLabel={rendered.periodLabel}
      logoSrc={branding.logoAssetId ? `/r/${token}/logo` : null}
    >
      {rendered.node}
    </WhiteLabelFrame>
  );
}
