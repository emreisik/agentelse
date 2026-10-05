import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { MAX_PROGRESS_IDS, hasChatProgressSince } from "@/server/chat/progress";

const ID_PATTERN = /^[\w.:-]{1,128}$/;

// Polling target of the chat while work is in flight (project-chat.tsx): says
// whether the page rendered at `since` is out of date, so the chat refreshes
// only when something changed instead of re-rendering the whole page every few
// seconds. ?since=<ISO time the page was rendered>&ids=<in-flight row ids>.
// An unreadable `since` answers "changed": the chat then refreshes as before.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  const search = new URL(request.url).searchParams;
  const since = new Date(search.get("since") ?? "");
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ changed: true });
  }
  const ids = (search.get("ids") ?? "")
    .split(",")
    .filter((id) => ID_PATTERN.test(id))
    .slice(0, MAX_PROGRESS_IDS);

  const changed = await hasChatProgressSince(projectId, since, ids);
  return NextResponse.json(
    { changed },
    { headers: { "Cache-Control": "no-store" } },
  );
}
