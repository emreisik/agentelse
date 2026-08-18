import { redirect } from "next/navigation";

// Brand Brain is now HUB CORE's own orbit panel (see ../page.tsx +
// src/components/hub-core/panels/marka-beyni-panel.tsx) — this route stays
// alive so old bookmarks/links don't break.
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
