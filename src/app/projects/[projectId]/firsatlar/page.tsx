import { redirect } from "next/navigation";

// Fırsatlar artık HUB CORE'un İçgörü & Fırsat / Hedefler panelleri
// (bkz. ../page.tsx) — bu rota eski yer imleri/linkler kırılmasın diye
// canlı tutuluyor.
export default async function FirsatlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const panel =
    typeof sp.tab === "string" && sp.tab === "hedefler"
      ? "hedefler"
      : "icgoru-firsat";

  const qp = new URLSearchParams({ panel });
  if (typeof sp.firsat === "string")
    qp.set("entity", `opportunity:${sp.firsat}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
