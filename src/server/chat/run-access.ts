import "server-only";

import { NextResponse } from "next/server";

import { isRateLimited } from "@/lib/rate-limit";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The gate of the chat-run endpoints (the list, re-attach and cancel under
// /api/projects/[projectId]/chat/runs): a session, membership of the project
// (another project's answers like a missing one) and a light per-user rate
// limit. Re-attaching and the sidebar's poll are cheap; a runaway client loop
// is not. In-memory like every limit here (rate-limit.ts).
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

export type RunEndpoint = "list" | "attach" | "cancel";

export async function authorizeRunRoute(
  projectId: string,
  endpoint: RunEndpoint,
): Promise<{ userId: string } | { response: NextResponse }> {
  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return {
        response: NextResponse.json({ error: "Not found" }, { status: 404 }),
      };
    }
    throw error;
  }

  if (
    isRateLimited(
      `chat-runs:${endpoint}:${userId}`,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
    )
  ) {
    return {
      response: NextResponse.json(
        { error: "Too many requests. Please slow down for a moment." },
        { status: 429 },
      ),
    };
  }

  return { userId };
}
