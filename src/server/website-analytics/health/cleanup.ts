import "server-only";

import { prisma } from "@/lib/prisma";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";
import { SiteAlerts } from "@/server/monitoring/site-alerts";

// Disconnect (google-disconnect.ts): projenin GA ölçüm uyarıları hemen
// silinir. Kimlik satırı proje başına tektir (projectId + provider); bağ
// kalmamış olsa da proje kimlikten okunur. Kontrol sonuçları ve denetim
// durumu bağ silinince cascade ile gider. Search Console kimliğinin
// koparılması GA uyarılarına dokunmaz.
export async function deleteGaHealthAlertsForCredential(
  credentialId: string,
): Promise<number> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: credentialId },
    select: { projectId: true, provider: true },
  });
  if (!credential || credential.provider !== GOOGLE_PROVIDER.analytics) {
    return 0;
  }
  return SiteAlerts.deleteForProjects([credential.projectId], "GA4");
}
