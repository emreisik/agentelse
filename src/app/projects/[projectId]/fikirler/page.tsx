import { redirect } from "next/navigation";

// Ideas is now one of HUB CORE's orbit panels (see ../page.tsx +
// src/components/hub-core/panels/fikirler-panel.tsx) — this route stays
// alive so old bookmarks/links don't break.
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
