import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old departments page. This route stays alive so old bookmarks/links keep
// working.
export default async function DepartmanlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(projectId, "departmanlar", {
      entity:
        typeof sp.denetim === "string"
          ? { kind: "department", id: sp.denetim }
          : null,
    }),
  );
}
