import { redirect } from "next/navigation";

const VALID_PANELS = ["sinyaller", "icgoru-firsat", "hedefler", "marka-beyni"];

// Zekâ artık HUB CORE'un üç yörünge paneline ayrıldı (Sinyaller / İçgörü &
// Fırsat / Hedefler — Marka Beyni ayrı bir düğüm; bkz. ../page.tsx +
// src/components/hub-core/panels/*.tsx) — bu rota eski yer imleri/linkler
// kırılmasın diye canlı tutuluyor, doğru panele/derin linke yönlendiriyor.
export default async function ZekaRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const requestedTab = typeof sp.tab === "string" ? sp.tab : undefined;
  const panel =
    requestedTab && VALID_PANELS.includes(requestedTab)
      ? requestedTab
      : typeof sp.firsat === "string"
        ? "icgoru-firsat"
        : typeof sp.sinyal === "string"
          ? "sinyaller"
          : "hedefler";

  const qp = new URLSearchParams({ panel });
  if (typeof sp.sinyal === "string") qp.set("entity", `signal:${sp.sinyal}`);
  if (typeof sp.firsat === "string")
    qp.set("entity", `opportunity:${sp.firsat}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
