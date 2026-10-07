import "server-only";

import { SeoReportBody } from "@/components/search-reports/seo-report-body";
import { seoReportsOn } from "@/lib/seo/reports/flags";
import { readSeoReportView } from "@/server/seo/reports/store";
import { registerShareRenderer } from "./renderers";

// 'SEARCH' paylaşımının çizicisi: saklanan değişmez SeoReport anlık görüntüsü.
// forShare okuması canlı SeoFinding sorgusunu ve uygulama bağlantılarını hiç
// kurmaz; yine de findingStatus / searchHref / chatHref boşaltılır, böylece
// Accept / Dismiss düğmesi ve uygulamaya giden bağlantı çıkmaz. projectId de
// boşaltılır: istemci bileşenlerine (karar düğmesi) kimlik gitmesin. Çizici
// veritabanına yazmaz. PULSE kartı paylaşılmaz.

registerShareRenderer("SEARCH", async ({ projectId, reportId }) => {
  if (!seoReportsOn()) return null;
  const view = await readSeoReportView(projectId, reportId, {
    forShare: true,
  });
  if (!view || view.projectId !== projectId) return null;
  if (view.kind === "PULSE") return null;
  const safe = {
    ...view,
    projectId: "",
    findingStatus: null,
    searchHref: null,
    chatHref: null,
    contentPlanLive: false,
  };
  return {
    title: view.title,
    periodLabel: view.snapshot.period.label,
    node: <SeoReportBody view={safe} />,
  };
});
