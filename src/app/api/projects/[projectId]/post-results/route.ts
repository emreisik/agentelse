import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadPostResults } from "@/server/agency/learning/post-results";

// The results views (a published post's card, the "See results" dialog) read
// this when they open: published posts, the owner's verdicts and, for
// Instagram, the live likes and comments. A GET, not a Server Action: actions
// run one at a time per client, and a slow Meta answer must not hold the chat.
// The numbers are read for this response only and never stored.
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

  const raw = new URL(request.url).searchParams.get("creativeId");
  const creativeId = raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined;
  try {
    const results = await loadPostResults(projectId, { creativeId });
    return NextResponse.json(results, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[api/post-results] failed:", error);
    return NextResponse.json({ error: "Could not load results" }, { status: 500 });
  }
}
