import { NextResponse } from "next/server";

import { authorizeRunRoute } from "@/server/chat/run-access";
import { cancelRun, findRunByCommandId } from "@/server/chat/run-registry";
import { CommandRepository } from "@/server/repositories/command.repository";

// Stop: ends a turn that is being written. A live run ends at once as STOPPED
// (whoever follows it gets the final `done`); a turn whose run is gone (the
// process restarted) is settled as STOPPED in place.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; commandId: string }> },
) {
  const { projectId, commandId } = await params;
  const gate = await authorizeRunRoute(projectId, "cancel");
  if ("response" in gate) return gate.response;

  const run = findRunByCommandId(commandId);
  if (run && run.projectId === projectId && run.endedAt === null) {
    cancelRun(run, "user");
    return NextResponse.json({ ok: true, live: true });
  }
  if (!run) {
    await CommandRepository.markStopped({ projectId, commandId }).catch(
      (error) => {
        console.error(
          "[chat-runs] settling a stopped turn failed:",
          error instanceof Error ? error.message : error,
        );
      },
    );
  }
  return NextResponse.json({ ok: true, live: false });
}
