import { NextResponse } from "next/server";

import {
  deauthorizeInstagramUser,
  readSignedUserId,
} from "@/server/integrations/meta-data-requests";

// "Deauthorize callback URL" (Meta App Dashboard > Instagram > Business login
// settings): called when someone removes Agentelse from their Instagram account.
// No session: the request is trusted only if its signed_request verifies.
export async function POST(request: Request) {
  const userId = await readSignedUserId(request);
  if (!userId) {
    console.warn("[meta-deauthorize] rejected: missing or invalid signed_request");
    return NextResponse.json({ error: "invalid_signed_request" }, { status: 400 });
  }
  try {
    const revoked = await deauthorizeInstagramUser(userId);
    // One line per verified request, so it can be seen what Meta really sent and
    // whether it matched anything. Only the id's length is logged, never the id.
    console.info(
      `[meta-deauthorize] verified request (id length ${userId.length}): ${revoked} connection(s) revoked`,
    );
  } catch (error) {
    // Meta retries on a 5xx.
    console.error("[meta-deauthorize] failed:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({});
}
