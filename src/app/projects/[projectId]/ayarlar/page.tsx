import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old settings page. This route stays alive so old bookmarks/links keep
// working; its Turkish tab names map to the Settings panel's sub-tabs.
export default async function AyarlarRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(projectId, "ayarlar", {
      sub: typeof sp.tab === "string" ? sp.tab : "otonomi",
    }),
  );
}
