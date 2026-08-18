import { redirect } from "next/navigation";

// Fikirler artık HUB CORE'un bir yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/fikirler-panel.tsx) — bu rota eski yer
// imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function FikirlerRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const qp = new URLSearchParams({ panel: "fikirler" });
  if (typeof sp.fikir === "string") qp.set("entity", `idea:${sp.fikir}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
