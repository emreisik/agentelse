import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

const LEGACY_TABS = ["sinyaller", "icgoru-firsat", "hedefler", "marka-beyni"];

// Old intelligence hub: its three tabs and Brand Brain are all Brand Brain
// tabs now. This route stays alive so old bookmarks/links keep working,
// redirecting to the matching tab or record.
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
  const legacyPanel =
    requestedTab && LEGACY_TABS.includes(requestedTab)
      ? requestedTab
      : typeof sp.firsat === "string"
        ? "icgoru-firsat"
        : typeof sp.sinyal === "string"
          ? "sinyaller"
          : "hedefler";

  redirect(
    legacyRouteHref(projectId, legacyPanel, {
      entity:
        typeof sp.firsat === "string"
          ? { kind: "opportunity", id: sp.firsat }
          : typeof sp.sinyal === "string"
            ? { kind: "signal", id: sp.sinyal }
            : null,
    }),
  );
}
