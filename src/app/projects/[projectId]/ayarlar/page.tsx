import { redirect } from "next/navigation";

const VALID_SUBS = ["otonomi", "kararlar", "aktivite", "tehlike"];

// Ayarlar artık HUB CORE'un bir yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/ayarlar-panel.tsx) — bu rota eski yer
// imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function AyarlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const sub =
    typeof sp.tab === "string" && VALID_SUBS.includes(sp.tab)
      ? sp.tab
      : "otonomi";

  redirect(`/projects/${projectId}?panel=ayarlar&sub=${sub}`);
}
