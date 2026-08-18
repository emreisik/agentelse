import { redirect } from "next/navigation";

const VALID_SUBS = ["planlar", "gorevler", "devirler", "olcumler"];

// İşler artık HUB CORE'un bir yörünge paneli (bkz. ../page.tsx +
// src/components/hub-core/panels/isler-panel.tsx) — bu rota eski yer
// imleri/linkler kırılmasın diye canlı tutuluyor.
export default async function IslerRedirect({
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
      : "planlar";

  const qp = new URLSearchParams({ panel: "isler", sub });
  if (typeof sp.plan === "string") qp.set("entity", `workPlan:${sp.plan}`);
  if (typeof sp.gorev === "string") qp.set("entity", `task:${sp.gorev}`);

  redirect(`/projects/${projectId}?${qp.toString()}`);
}
