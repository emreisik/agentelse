import { redirect } from "next/navigation";

// Opportunities is now covered by HUB CORE's Insight & Opportunity / Goals
// panels (see ../page.tsx) — this route stays alive so old bookmarks/links
// don't break.
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
