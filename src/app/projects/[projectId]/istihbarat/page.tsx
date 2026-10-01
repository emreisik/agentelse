import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old intelligence page: signals and insights now live in the Brand Brain's
// Intelligence tab. This route stays alive so old bookmarks/links keep working.
export default async function IstihbaratRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(projectId, "sinyaller", {
      entity:
        typeof sp.sinyal === "string"
          ? { kind: "signal", id: sp.sinyal }
          : null,
    }),
  );
}
