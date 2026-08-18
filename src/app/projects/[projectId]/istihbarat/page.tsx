import { redirect } from "next/navigation";

// İstihbarat artık HUB CORE'un Sinyaller / İçgörü & Fırsat panelleri
// (bkz. ../page.tsx) — bu rota eski yer imleri/linkler kırılmasın diye
// canlı tutuluyor.
export default async function IstihbaratRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const oldTab = typeof sp.tab === "string" ? sp.tab : "sinyaller";
  const panel = oldTab === "icgoruler" ? "icgoru-firsat" : "sinyaller";

  const qp = new URLSearchParams({ panel });
  if (typeof sp.sinyal === "string") qp.set("entity", `signal:${sp.sinyal}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
