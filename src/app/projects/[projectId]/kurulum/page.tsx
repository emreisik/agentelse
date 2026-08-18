import { redirect } from "next/navigation";

// Kurulum artık HUB CORE'un bir yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/kurulum-panel.tsx) — bu rota eski yer
// imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function KurulumRedirect({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}?panel=kurulum`);
}
