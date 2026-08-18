import { redirect } from "next/navigation";

// Departmanlar artık HUB CORE'un bir yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/departmanlar-panel.tsx) — bu rota eski
// yer imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function DepartmanlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const qp = new URLSearchParams({ panel: "departmanlar" });
  if (typeof sp.denetim === "string")
    qp.set("entity", `department:${sp.denetim}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
