import { redirect } from "next/navigation";

import {
  buildHubHref,
  entityHref,
} from "@/components/hub-core/hub-core-params";

// The standalone Flow panel was removed — this route stays alive so
// old bookmarks/links don't break. The legacy `kart=idea:ID|workPlan:ID|task:ID`
// deep link redirects to the panel that owns that record (Ideas/Work); if
// there's no match it now falls through to the Ideas panel (it used to fall
// through to the project root/chat).
export default async function AkisRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  if (typeof sp.kart === "string") {
    const separatorIndex = sp.kart.indexOf(":");
    const kind = sp.kart.slice(0, separatorIndex);
    const id = sp.kart.slice(separatorIndex + 1);
    if (
      separatorIndex > 0 &&
      id &&
      (kind === "idea" || kind === "workPlan" || kind === "task")
    ) {
      redirect(entityHref(projectId, { kind, id }));
    }
  }

  redirect(buildHubHref(projectId, { panel: "ideas" }));
}
