import "server-only";

import { ClientReportView } from "@/components/website-analytics/agency/client-report-view";
import { websiteCardToDocument } from "@/lib/website-analytics/agency/client-report/convert";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { registerShareRenderer } from "@/server/report-share/renderers";
import { loadWebsiteReportForClient } from "./share";

// GA-F8: 'WEBSITE' paylaşımının çizicisi. /r/[token] sayfası (SC-F9) belirteci
// çözüp kaydı sayar, çerçeveyi (marka, logo, alt bilgi) kendisi çizer; burada
// yalnız saklı kartın müşteri belgesi çizilir. SC-F9'un herkese açık okuma
// yolunda yerel izin listesi bekçisi yoktur, bu yüzden bayrak ve bekçi burada
// uygulanır: kapalıyken ya da kart/bağ yokken null (SC-F9'un nötr bulunamadı
// sayfası). Çizici veritabanına yazmaz.

registerShareRenderer("WEBSITE", async ({ projectId, reportId, branding }) => {
  if (!gaAgencyEnabledFor(projectId)) return null;
  // Plan, nabız ve uyarı kartları paylaşılamaz: allowPlan false, kimlik öneki
  // de weekly | monthly dışını eler.
  const card = await loadWebsiteReportForClient({
    projectId,
    commandId: reportId,
    allowPlan: false,
  });
  if (!card) return null;
  // Müşteri adı yok: paylaşımı alan zaten müşteridir, iç proje adı sızmaz.
  const doc = websiteCardToDocument(card, {
    clientName: "",
    agencyName: branding.displayName,
    forShare: true,
  });
  if (!doc) return null;
  return {
    title: doc.title,
    periodLabel: doc.periodLabel,
    node: <ClientReportView doc={doc} />,
  };
});
