import { NextResponse } from "next/server";
import { z } from "zod";

import { isRateLimited } from "@/lib/rate-limit";
import { runContentPlan } from "@/server/chat/plan-run";
import { sseRunResponse } from "@/server/chat/run-response";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// "Save & produce" / "Produce" on a saved content-plan card: produces the
// nearest week of the plan's empty calendar slots (the server picks them, see
// plan-run.ts) and streams the run as Server-Sent Events (run.items, then the
// item.* / package.done variants of ChatStreamEvent — src/server/chat/types.ts),
// so the chat shows each piece being made live. Same wire format and
// keep-alive as the package route next door.

// A production run is a deliberate click, not typing: a tight per-user cap is
// only a runaway-client guard (the claim itself already makes a run happen
// once).
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;

const BodySchema = z.object({
  // The plan's own chat Command (the plan card's row).
  commandId: z.string().min(1),
  // "Make this post": only this post's deliveries, not the week.
  postId: z.string().min(1).max(64).optional(),
});

export async function POST(
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

  let access: Awaited<ReturnType<typeof requireProjectAccess>>;
  try {
    access = await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (isRateLimited(`plan-run:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down for a moment." },
      { status: 429 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  return sseRunResponse({
    projectId,
    logTag: "plan-route",
    failureMessage: "Could not start the production",
    run: () =>
      runContentPlan({
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        userId,
        commandId: body.commandId,
        ...(body.postId ? { postId: body.postId } : {}),
      }),
  });
}
