import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old work page. This route stays alive so old bookmarks/links keep working;
// its Turkish tab names map to the Work panel's sub-tabs.
export default async function IslerRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(projectId, "isler", {
      sub: typeof sp.tab === "string" ? sp.tab : "planlar",
      entity:
        typeof sp.plan === "string"
          ? { kind: "workPlan", id: sp.plan }
          : typeof sp.gorev === "string"
            ? { kind: "task", id: sp.gorev }
            : null,
    }),
  );
}
