import { redirect } from "next/navigation";

import { legacyRouteHref } from "@/components/hub-core/hub-core-params";

// Old Brand Brain page. This route stays alive so old bookmarks/links keep
// working; its findings tab moved to the Intelligence tab.
export default async function BeyinRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  redirect(
    legacyRouteHref(
      projectId,
      typeof sp.tab === "string" && sp.tab === "bulgular"
        ? "sinyaller"
        : "marka-beyni",
    ),
  );
}
