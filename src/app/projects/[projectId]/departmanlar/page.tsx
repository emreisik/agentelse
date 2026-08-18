import { redirect } from "next/navigation";

// Departments is now one of HUB CORE's orbit panels (see ../page.tsx +
// src/components/hub-core/panels/departmanlar-panel.tsx) — this route
// stays alive so old bookmarks/links don't break.
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
