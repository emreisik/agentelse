import { NextResponse } from "next/server";

import { authorizeRunRoute } from "@/server/chat/run-access";
import { listActiveRuns } from "@/server/chat/run-registry";

// The chat turns of a project being written right now (the sidebar marks
// their chats as working while it polls this).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const gate = await authorizeRunRoute(projectId, "list");
  if ("response" in gate) return gate.response;
  return NextResponse.json(
    { runs: listActiveRuns(projectId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
