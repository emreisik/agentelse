import { redirect } from "next/navigation";

const VALID_PANELS = ["sinyaller", "icgoru-firsat", "hedefler", "marka-beyni"];

// Intelligence is now split across three of HUB CORE's orbit panels
// (Signals / Insight & Opportunity / Goals — Brand Brain is a separate
// node; see ../page.tsx + src/components/hub-core/panels/*.tsx) — this
// route stays alive so old bookmarks/links don't break, redirecting to the
// correct panel/deep link.
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
