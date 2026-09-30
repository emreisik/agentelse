"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Sparkles } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WsEventCard } from "@/components/commands/ws-event-card";
import { useChatSend } from "@/components/commands/chat-send-context";
import {
  useGuidedSetup,
  type GuidedSetupApi,
} from "@/components/guide/guided-setup-context";
import {
  api,
  type ApiResult,
} from "@/components/guide/guided-setup-client";
import type {
  DraftPlanResult,
  GuidedSetupCardData,
} from "@/lib/guided-setup/contract";

const COPY = {
  openTitle: "Guided setup",
  unavailable: "Guided setup isn't available here.",
  doneTitle: "Setup saved",
  goal: (goal: string) => `Goal: ${goal}`,
  goalProposed: (goal: string) =>
    `Goal: ${goal} (waiting for your approval in Strategy)`,
  channels: (channels: string) => `Channels: ${channels}`,
  saved: (parts: string) => `Saved: ${parts}`,
  plan: "Draft my first plan",
  planHelp: "You review the plan before anything is saved.",
  planPending: "Drafting…",
  planFailed: "Couldn't draft the plan. Try again.",
  connect: "Connect accounts",
  edit: "Edit setup",
} as const;

// The stored card is only shallow-checked, so every optional field may be
// missing or of the wrong shape on an old or hand-edited row.
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

// Asks the server for the first-plan message, then hands it to the chat once.
// Resolves to an inline error text, or null when the message was sent.
export async function requestFirstPlan(
  draft: () => Promise<ApiResult<DraftPlanResult>>,
  send: (text: string) => Promise<void>,
): Promise<string | null> {
  try {
    const result = await draft();
    if (!result.ok) return COPY.planFailed;
    if (!result.data.ok) return result.data.message;
    // Once: the agent's own plan flow drafts a card from this brief.
    await send(result.data.message);
    return null;
  } catch {
    return COPY.planFailed;
  }
}

// Stateless launcher (state "open") or receipt (state "done"). With a null
// context (flag off, or an idea thread) nothing can open the sheet, so it is
// one inert line: no button and no link.
export function GuidedSetupCard({
  card,
}: {
  card: GuidedSetupCardData;
  // Part of the shared card signature; this card holds no per-row state.
  commandId?: string;
}) {
  const guided = useGuidedSetup();

  if (!guided) {
    return (
      <p className="mt-1 text-sm" style={{ color: "var(--ws-text-3)" }}>
        {card.state === "done" ? COPY.doneTitle : COPY.unavailable}
      </p>
    );
  }

  if (card.state === "done") return <Receipt card={card} guided={guided} />;

  return (
    <WsEventCard icon={Sparkles} title={COPY.openTitle}>
      <Button
        type="button"
        size="sm"
        className="w-full any-pointer-coarse:min-h-11"
        onClick={() =>
          guided.open("card", { seedCommandId: card.sourceCommandId })
        }
      >
        {guided.entry.label}
      </Button>
    </WsEventCard>
  );
}

function Receipt({
  card,
  guided,
}: {
  card: GuidedSetupCardData;
  guided: GuidedSetupApi;
}) {
  const send = useChatSend();
  const [phase, setPhase] = useState<"idle" | "pending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  // A double tap must not send two plan requests before state re-renders.
  const inFlight = useRef(false);

  const summary = card.summary;
  const goal = typeof summary?.goal === "string" ? summary.goal : "";
  const channels = textList(summary?.channels);
  const saved = textList(summary?.saved);
  const unconnected = textList(summary?.unconnected);
  const showPlan =
    summary?.canDraftPlan === true &&
    guided.canDraftPlan &&
    send !== null;

  const draftPlan = async () => {
    if (!send || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPhase("pending");
    const failure = await requestFirstPlan(
      () => api(card.projectId, (input, init) => fetch(input, init)).draftPlan(),
      send,
    );
    inFlight.current = false;
    setError(failure);
    setPhase(failure === null ? "sent" : "idle");
  };

  return (
    <WsEventCard icon={CheckCircle2} title={COPY.doneTitle}>
      <div className="space-y-1 text-sm" style={{ color: "var(--ws-text-2)" }}>
        {goal ? (
          <p>
            {summary?.goalProposed === true
              ? COPY.goalProposed(goal)
              : COPY.goal(goal)}
          </p>
        ) : null}
        {channels.length > 0 ? (
          <p>{COPY.channels(channels.join(", "))}</p>
        ) : null}
        {saved.length > 0 ? <p>{COPY.saved(saved.join(", "))}</p> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {showPlan ? (
          <Button
            type="button"
            size="sm"
            className="any-pointer-coarse:min-h-11"
            disabled={phase !== "idle"}
            onClick={() => void draftPlan()}
          >
            {phase === "pending" ? COPY.planPending : COPY.plan}
          </Button>
        ) : null}
        {unconnected.length > 0 ? (
          <Link
            href={`/projects/${encodeURIComponent(card.projectId)}/integrations`}
            className={cn(
              buttonVariants({ size: "sm", variant: "outline" }),
              "any-pointer-coarse:min-h-11",
            )}
          >
            {COPY.connect}
          </Link>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="any-pointer-coarse:min-h-11"
          onClick={() => guided.open("card")}
        >
          {COPY.edit}
        </Button>
      </div>
      {showPlan && phase === "idle" && !error ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          {COPY.planHelp}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-2 text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {error}
        </p>
      ) : null}
    </WsEventCard>
  );
}
