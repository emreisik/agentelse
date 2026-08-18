import { redirect } from "next/navigation";

// Intelligence is now covered by HUB CORE's Signals / Insight & Opportunity
// panels (see ../page.tsx) — this route stays alive so old bookmarks/links
// don't break.
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
