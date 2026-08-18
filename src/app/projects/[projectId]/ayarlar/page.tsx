import { redirect } from "next/navigation";

const VALID_SUBS = ["otonomi", "kararlar", "aktivite", "tehlike"];

// Settings is now one of HUB CORE's orbit panels (see ../page.tsx +
// src/components/hub-core/panels/ayarlar-panel.tsx) — this route stays
// alive so old bookmarks/links don't break.
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
