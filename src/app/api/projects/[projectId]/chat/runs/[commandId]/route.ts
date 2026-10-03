import { NextResponse } from "next/server";

import { authorizeRunRoute } from "@/server/chat/run-access";
import { findRunByCommandId } from "@/server/chat/run-registry";
import { chatRunResponse } from "@/server/chat/run-sse";

// Re-attach: the SSE stream of a turn that is still being written (or ended a
// moment ago), replayed from its start and then followed live, exactly like
// the POST that started it. A turn this process does not run answers 410: the
// page's own rows are then the whole story.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; commandId: string }> },
) {
  const { projectId, commandId } = await params;
  const gate = await authorizeRunRoute(projectId, "attach");
  if ("response" in gate) return gate.response;
  const run = findRunByCommandId(commandId);
  if (!run || run.projectId !== projectId) {
    return NextResponse.json({ error: "not_running" }, { status: 410 });
  }
  return chatRunResponse(run, request.signal);
}
