import { redirect } from "next/navigation";

// Setup is now one of HUB CORE's orbit panels (see ../page.tsx +
// src/components/hub-core/panels/kurulum-panel.tsx) — this route stays
// alive so old bookmarks/links don't break.
export default async function KurulumRedirect({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}?panel=setup`);
}
