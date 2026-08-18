import { redirect } from "next/navigation";

// Marka Beyni artık HUB CORE'un kendi yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/marka-beyni-panel.tsx) — bu rota eski
// yer imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function BeyinRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const oldTab = typeof sp.tab === "string" ? sp.tab : "anayasa";
  const panel = oldTab === "bulgular" ? "sinyaller" : "marka-beyni";

  redirect(`/projects/${projectId}?panel=${panel}`);
}
