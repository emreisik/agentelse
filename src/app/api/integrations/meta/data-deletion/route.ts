import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { getEnv } from "@/lib/env";
import { createDeletionCode } from "@/lib/meta-signed-request";
import {
  deleteInstagramUserData,
  readSignedUserId,
} from "@/server/integrations/meta-data-requests";

// "Data deletion request URL" (Meta App Dashboard > Instagram > Business login
// settings): called when someone asks Meta to delete the data an app holds. The
// erasure is done before answering, so the status page (the `url` Meta shows the
// person) can truthfully say it is complete. Meta wants `{ url, confirmation_code }`.
export async function POST(request: Request) {
  const userId = await readSignedUserId(request);
  if (!userId) {
    console.warn("[meta-data-deletion] rejected: missing or invalid signed_request");
    return NextResponse.json({ error: "invalid_signed_request" }, { status: 400 });
  }
  let removed: number;
  try {
    removed = await deleteInstagramUserData(userId);
    // One line per verified request, so it can be seen what Meta really sent and
    // whether it matched anything. Only the id's length is logged, never the id.
    console.info(
      `[meta-data-deletion] verified request (id length ${userId.length}): ${removed} connection(s) erased`,
    );
  } catch (error) {
    console.error("[meta-data-deletion] failed:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const code = createDeletionCode(removed, getEnv().AUTH_SECRET);
  return NextResponse.json({
    url: appUrl(`/data-deletion?code=${code}`).toString(),
    confirmation_code: code,
  });
}
