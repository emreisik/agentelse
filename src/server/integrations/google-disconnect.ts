import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decryptGoogleSecret } from "@/server/integrations/google/secret";
import { forgetGoogleAccessTokens } from "@/server/integrations/google/access-token";
import { revokeGoogleToken } from "@/server/integrations/google/oauth";
import {
  shouldRevokeAtGoogle,
  type GoogleConnectionRef,
} from "@/server/integrations/google/revoke-policy";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";
import { forgetSeoActionsForCredential } from "@/server/seo/actions/forget";
import { deleteSearchConsoleAlerts } from "@/server/seo/health/alerts";
import { forgetSearchOpportunitiesForCredential } from "@/server/seo/opportunities/forget";
import { forgetSeoContentPlansForCredential } from "@/server/seo/content-plan/forget";
import { SeoSites } from "@/server/seo/site/sites";
import { deleteGaInsightDerivedDataForCredential } from "@/server/website-analytics/analysis/cleanup";
import { deleteGaAttributionDataForCredential } from "@/server/website-analytics/attribution/cleanup";
import { deleteGaHealthAlertsForCredential } from "@/server/website-analytics/health/cleanup";
import { deleteGaReportDataForCredential } from "@/server/website-analytics/reports/cleanup";
import { gaFixesEnabled } from "@/lib/website-analytics/fixes/flags";
import { cancelPendingGaFixesForCredential } from "@/server/website-analytics/fixes/cleanup";
import { forgetSeoGoalValues } from "@/server/seo/reports/goals";
import { forgetAgencyForCredential } from "@/server/seo/agency/forget";

// Google bağlantısını koparır (GA ya da Search Console; ikisi ayrı ayrı).
// google-token.ts gibi bir düzenleme adımıdır: REST çağrısı çekirdekte, DB
// burada.
//
// - Refresh token ve Google'dan okunan metadata (mülk/site listeleri, seçim,
//   test sonuçları, hesap e-postası) HEMEN silinir; satır REVOKED olur ve
//   yalnız yeni bir OAuth bağlantısı onu geri getirebilir.
// - Google'da iptal yalnız aynı Google hesabını kullanan başka canlı Agentelse
//   bağlantısı yoksa yapılır (revoke-policy.ts). Google iptali Cloud projesi
//   düzeyinde uyguladığı için, aksi hâlde diğer entegrasyon da kopardı.

type GoogleCredentialRow = {
  id: string;
  encryptedSecret: string;
  metadata: Prisma.JsonValue | null;
};

export type GoogleDisconnectResult = {
  revokedAtGoogle: boolean;
};

function refOf(row: GoogleCredentialRow): GoogleConnectionRef {
  const metadata = (row.metadata ?? {}) as {
    googleSub?: unknown;
    connectedEmail?: unknown;
  };
  return {
    id: row.id,
    encryptedSecret: row.encryptedSecret,
    googleSub:
      typeof metadata.googleSub === "string" ? metadata.googleSub : null,
    email:
      typeof metadata.connectedEmail === "string"
        ? metadata.connectedEmail
        : null,
  };
}

async function sameAccountConnections(
  target: GoogleConnectionRef,
): Promise<GoogleConnectionRef[]> {
  const sameAccount: Prisma.IntegrationCredentialWhereInput[] = [
    { encryptedSecret: target.encryptedSecret },
  ];
  if (target.googleSub) {
    sameAccount.push({
      metadata: { path: ["googleSub"], equals: target.googleSub },
    });
  }
  if (target.email) {
    sameAccount.push({
      metadata: { path: ["connectedEmail"], equals: target.email },
    });
  }
  const rows = await prisma.integrationCredential.findMany({
    where: {
      id: { not: target.id },
      provider: {
        in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
      },
      status: { not: "REVOKED" },
      OR: sameAccount,
    },
    select: { id: true, encryptedSecret: true, metadata: true },
  });
  return rows.map(refOf);
}

export async function disconnectGoogleCredential(
  credential: GoogleCredentialRow,
): Promise<GoogleDisconnectResult> {
  const target = refOf(credential);
  let revokedAtGoogle = false;

  if (target.encryptedSecret && (target.googleSub || target.email)) {
    const others = await sameAccountConnections(target);
    if (shouldRevokeAtGoogle(target, others)) {
      try {
        await revokeGoogleToken(decryptGoogleSecret(target.encryptedSecret));
        revokedAtGoogle = true;
      } catch (error) {
        // İptal en iyi çabadır: başarısız olsa da bizim token'ımız aşağıda
        // silinir; kullanıcı izni Google hesabından da kaldırabilir.
        console.error(
          "[google-disconnect] revoke failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  forgetGoogleAccessTokens(credential.id);
  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      status: "REVOKED",
      encryptedSecret: "",
      metadata: { disconnectedAt: new Date().toISOString() },
    },
  });
  // Google Analytics ambarı (Ga*) ve Search Console ambarı (Gsc*: bağ, günlük
  // toplamlar, kırılımlar, sözlükler, haftalık/aylık özetler; SC-F3'ten beri
  // URL Inspection sonuçları, Search Console sitemap durumu ve kapsam
  // tahminleri: GscUrlInspection, GscSitemap, GscCoverageWeek; SC-F4'ten beri
  // SEO fırsat motorunun verisi: SeoFinding, SeoCluster, SeoQueryEmbedding,
  // SeoEngineState) bağ silinince cascade ile gider; gizlilik metni "right
  // away" der.
  // GA-F3: projenin GA ölçüm uyarıları hemen silinir; kontrol sonuçları ve denetim durumu bağ silinince cascade ile gider.
  // Hata ambar silmesini durdurmasın (token zaten silindi, yeniden deneme
  // iptali atlar); kalan GA4 uyarılarını GA-F3 temizliği yetim olarak kapatır.
  await deleteGaHealthAlertsForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] measurement alerts could not be deleted:",
        error instanceof Error ? error.message : error,
      );
      return 0;
    },
  );
  // GA-F4: bulgulardan türeyen sinyal, ajans bulgusu/içgörüsü/dokunulmamış fırsat, öğrenme ve havuzdaki "website" fikirleri hemen silinir; GaFinding/GaAnalysisRun bağla birlikte cascade ile gider. Search Console kimliğinde no-op.
  // Hata ambar silmesini durdurmasın; kalanları GaRetention'ın yetim bağ adımı siler.
  await deleteGaInsightDerivedDataForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] website insight data could not be cleared:",
        error instanceof Error ? error.name : error,
      );
    },
  );
  // GA-F6: GA'dan türeyen "ga-utm:" öğrenmeleri ve Meta karar kanıtındaki bütün ga4_* sayıları hemen silinir. TrackedLink ve link izleme ayarı Google verisi değildir, kalır. Search Console kimliğinde no-op.
  // Hata Disconnect'i durdurmasın; kalanı GaRetention'ın proje taraması (sweepOrphanGaAttributionData) siler.
  await deleteGaAttributionDataForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] attribution data could not be deleted:",
        error instanceof Error ? error.name : error,
      );
    },
  );
  // GA-F7: bekleyen onaylar iptal edilir, Task/sohbet kartı metinleri silinir; GaConfigChange ve GaChangeWatch satırları bağ silinince cascade ile gider; GA4 uyarıları zaten deleteGaHealthAlertsForCredential ile silinir. Bayrak kapalıyken ek sorgu yoktur.
  if (gaFixesEnabled()) {
    await cancelPendingGaFixesForCredential(credential.id).catch(
      (error: unknown) => {
        console.error(
          "[google-disconnect] pending fixes could not be cancelled:",
          error instanceof Error ? error.name : error,
        );
      },
    );
  }
  await prisma.gaPropertyLink.deleteMany({
    where: { credentialId: credential.id },
  });
  // GA-F5: Website analytics sohbetindeki rapor kartları (garep_*), boş kalan sohbet ve web.* hedeflerinin GA'dan yazılan güncel değeri hemen silinir; GaReportRun ve GaGoalProgress bağla birlikte cascade ile gider. Ayarlar, kullanıcının kendi mesajları ve hedeflerin kendisi kalır (Google verisi değil). Search Console kimliğinde no-op.
  // Bağ silindikten SONRA çalışır: yazarların (haftalık/aylık rapor, hedef
  // yenileme) "bağ var" denetimi artık geçmez, silmeden sonra yeni kart ya da
  // hedef değeri yazılamaz. Hata ambar silmesini durdurmasın; kalanları
  // GaRetention'ın proje taraması (sweepOrphanGaReportData) siler.
  await deleteGaReportDataForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] website report data could not be deleted:",
        error instanceof Error ? error.name : error,
      );
    },
  );
  // Search Console'dan türeyen arama sağlığı uyarıları (source GSC) bayraktan
  // bağımsız hemen silinir; site tarayıcısının kendi uyarıları (SEO) kalır.
  const searchAlerts = await deleteSearchConsoleAlerts(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] search alerts could not be deleted:",
        error instanceof Error ? error.message : error,
      );
      return { deleted: 0, projectIds: [] as string[] };
    },
  );
  // SC-F4: fırsat motorunun Search Console'dan türeyen sinyalleri ve havuzdaki kanıtlı fikirleri bayraktan bağımsız silinir; bulgular, kümeler, embedding'ler ve motor durumu bağla birlikte cascade ile gider.
  await forgetSearchOpportunitiesForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] search opportunity data could not be cleared:",
        error instanceof Error ? error.message : error,
      );
    },
  );
  // SC-F7: aylık SEO içerik planı bayraktan bağımsız kalıcı silinir: dokunulmamış slot parçaları ve plana ait fikirler; plan satırları bağla birlikte cascade ile gider. Yazılmış makaleler kullanıcının içeriğidir, kalır.
  await forgetSeoContentPlansForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] seo content plan data could not be cleared:",
        error instanceof Error ? error.name : error,
      );
    },
  );
  const searchProjects = (
    await prisma.gscSiteLink.findMany({
      where: { credentialId: credential.id },
      select: { projectId: true },
    })
  ).map((row) => row.projectId);
  // SC-F6: Search Console bağına ait SEO eylemleri (ölçüm sonuçları, inceleme kanıtı), onlardan türeyen SEO öğrenmeleri ve SEO kartlarındaki Search Console verisi bayraktan bağımsız hemen silinir.
  await forgetSeoActionsForCredential(credential.id).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] seo actions could not be deleted:",
        error instanceof Error ? error.message : error,
      );
    },
  );
  // SC-F9: paylaşım bağlantıları, sayfa grubu kuralları, ek site listesi ve BigQuery kaynakları Disconnect'te projeye göre hemen silinir (bağ satırı kalmamış olsa bile); bölünmüş testler bağla cascade ile gider. Bayraktan bağımsızdır; Analytics kimliğinde sıfır döner.
  await forgetAgencyForCredential(credential.id).catch((error: unknown) => {
    console.error(
      "[google-disconnect] search agency data could not be cleared:",
      error instanceof Error ? error.name : error,
    );
  });
  await prisma.gscSiteLink.deleteMany({
    where: { credentialId: credential.id },
  });
  // SC-F5: Search raporları, rapor durumu ve hedef ilerlemesi bağla cascade silinir; SEO hedeflerinin Google'dan gelen güncel değeri de hemen boşaltılır.
  // Hata Disconnect'i durdurmasın; kalan değeri SeoReportRetention'ın günlük adımı boşaltır.
  await forgetSeoGoalValues([...new Set(searchProjects)]).catch(
    (error: unknown) => {
      console.error(
        "[google-disconnect] seo goal values could not be cleared:",
        error instanceof Error ? error.name : error,
      );
      return 0;
    },
  );
  // Denetimdeki GSC kökenli durum (inceleme kuyruğu, puan, yalnız GSC'den
  // bilinen sayfalar) silinir; kapsamı Search Console'dan gelen sitenin tarama
  // verisi sıfırlanır (alan adı doğrulaması korunur).
  if (searchAlerts.projectIds.length > 0) {
    await SeoSites.forgetSearchConsoleData(searchAlerts.projectIds, {
      resetScope: true,
    }).catch((error: unknown) => {
      console.error(
        "[google-disconnect] site audit state could not be cleared:",
        error instanceof Error ? error.message : error,
      );
    });
  }
  return { revokedAtGoogle };
}
