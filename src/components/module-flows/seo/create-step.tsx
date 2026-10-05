"use client";

import { CardActions } from "@/components/works/card-actions";
import {
  goToSeoStepAction,
  writeSeoArticleAction,
} from "@/server/actions/seo-flow-actions";

import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  WorkingNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Step 3, Create: the article is being written from the plan. The card waits
// here, calmly; if the writing stopped before it answered, it says so and
// offers to write again from the stored plan.

const RETRY = "retry";
const BACK = "goto:plan";

export function CreateStep({
  projectId,
  commandId,
  running,
  blocked,
  onMoving,
}: {
  projectId?: string;
  commandId?: string;
  running: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
}) {
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [BACK]: "plan" },
    server: (id, card) =>
      id === BACK
        ? goToSeoStepAction(card.projectId, card.commandId, "plan")
        : writeSeoArticleAction(card.projectId, card.commandId),
  });
  if (running || busyId === RETRY) {
    return <WorkingNote>{COPY.writeNote}</WorkingNote>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {COPY.writeStopped}
      </p>
      <CardActions
        buttons={[
          serverButton(RETRY, COPY.tryAgain, "primary", blocked),
          serverButton(BACK, COPY.backToPlan, "quiet", blocked),
        ]}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}
