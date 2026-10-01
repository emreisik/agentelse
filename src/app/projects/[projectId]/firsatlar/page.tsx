import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old opportunities page: opportunities live in the Brand Brain's Intelligence
// tab and goals in its Goals tab. This route stays alive so old
// bookmarks/links keep working.
export default async function FirsatlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const legacyPanel =
    typeof sp.tab === "string" && sp.tab === "hedefler"
      ? "hedefler"
      : "icgoru-firsat";
  redirect(
    legacyRouteHref(projectId, legacyPanel, {
      entity:
        typeof sp.firsat === "string"
          ? { kind: "opportunity", id: sp.firsat }
          : null,
    }),
  );
}
