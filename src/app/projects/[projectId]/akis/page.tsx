import { redirect } from "next/navigation";

import {
  buildHubHref,
  entityHref,
} from "@/components/hub-core/hub-core-params";

// Standalone Akış paneli kaldırıldı — bu rota eski yer imleri/linkler
// kırılmasın diye canlı tutuluyor. Eski `kart=idea:ID|workPlan:ID|task:ID`
// derin linki, o kaydın sahibi olan panele (Fikirler/İşler) yönlendiriliyor;
// eşleşme yoksa artık Fikirler paneline düşer (eskiden proje köküne/sohbete
// düşüyordu).
export default async function AkisRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  if (typeof sp.kart === "string") {
    const separatorIndex = sp.kart.indexOf(":");
    const kind = sp.kart.slice(0, separatorIndex);
    const id = sp.kart.slice(separatorIndex + 1);
    if (
      separatorIndex > 0 &&
      id &&
      (kind === "idea" || kind === "workPlan" || kind === "task")
    ) {
      redirect(entityHref(projectId, { kind, id }));
    }
  }

  redirect(buildHubHref(projectId, { panel: "fikirler" }));
}
