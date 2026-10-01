import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old ideas page. This route stays alive so old bookmarks/links keep working.
export default async function FikirlerRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(projectId, "fikirler", {
      entity:
        typeof sp.fikir === "string" ? { kind: "idea", id: sp.fikir } : null,
    }),
  );
}
