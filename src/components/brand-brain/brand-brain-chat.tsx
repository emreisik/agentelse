"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { CONSTITUTION_SECTIONS } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  applyBrandBrainRevisionAction,
  sendBrandBrainMessageAction,
} from "@/server/actions/brand-brain-actions";
import type { BrandBrainRevision } from "@/server/reasoning/prompts/brand-brain-chat";

const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  CONSTITUTION_SECTIONS.map((s) => [s.key, s.label]),
);

export type BrandBrainChatTurn = {
  commandId: string;
  source: "WEB" | "SYSTEM";
  text: string;
  reply: string | null;
  proposedRevision: BrandBrainRevision | null;
  revisionSummary: string | null;
};

// Standing, always-open conversation at the top of the Brand Brain panel —
// discuss/challenge/refine the brand's constitution and strategy, and when
// the discussion reaches a concrete direction, the assistant proposes a
// revision card the client explicitly applies (or keeps discussing instead
// of). Modeled on Claude Code's own plan -> approve loop: narrate freely,
// only ask for a decision once there's something concrete to decide.
export function BrandBrainChat({
  projectId,
  initialTurns,
}: {
  projectId: string;
  initialTurns: BrandBrainChatTurn[];
}) {
  const [turns, setTurns] = useState(initialTurns);
  const [input, setInput] = useState("");
  const [isSending, startSending] = useTransition();
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const send = () => {
    const message = input.trim();
    if (!message) return;
    setInput("");
    startSending(async () => {
      const result = await sendBrandBrainMessageAction(projectId, message);
      if (!result.ok) {
        toast.error(result.message);
        setInput(message);
        return;
      }
      setTurns((prev) => [
        ...prev,
        {
          commandId: result.commandId,
          source: "WEB",
          text: message,
          reply: result.reply,
          proposedRevision: result.proposedRevision,
          revisionSummary: result.revisionSummary,
        },
      ]);
    });
  };

  const apply = (commandId: string) => {
    setApplyingId(commandId);
    applyBrandBrainRevisionAction(projectId, commandId)
      .then((result) => {
        if (result.ok) {
          setAppliedIds((prev) => new Set(prev).add(commandId));
          toast.success("Brand Brain updated");
        } else {
          toast.error(result.message);
        }
      })
      .finally(() => setApplyingId(null));
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">
          Brand Brain chat
        </p>
      </div>

      {turns.length > 0 ? (
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {turns.map((turn) => (
            <div key={turn.commandId} className="space-y-1.5">
              {turn.text ? (
                <p className="text-sm text-foreground">{turn.text}</p>
              ) : null}
              {turn.reply ? (
                <p className="text-sm whitespace-pre-line text-muted-foreground">
                  {turn.reply}
                </p>
              ) : null}
              {turn.proposedRevision && !dismissedIds.has(turn.commandId) ? (
                <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                  <p className="text-xs font-semibold text-foreground">
                    Proposed revision
                  </p>
                  {turn.revisionSummary ? (
                    <p className="text-xs text-muted-foreground">
                      {turn.revisionSummary}
                    </p>
                  ) : null}
                  <div className="space-y-1.5">
                    {Object.entries(turn.proposedRevision)
                      .filter(
                        ([, value]) => value !== null && value !== undefined,
                      )
                      .map(([key, value]) => (
                        <div key={key} className="text-xs">
                          <span className="font-medium text-foreground">
                            {SECTION_LABEL[key] ?? key}:
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {Array.isArray(value) ? value.join(", ") : value}
                          </span>
                        </div>
                      ))}
                  </div>
                  {appliedIds.has(turn.commandId) ? (
                    <p className="text-xs font-medium text-success">
                      ✅ Applied
                    </p>
                  ) : (
                    <div className="flex gap-1.5 pt-1">
                      <Button
                        type="button"
                        size="xs"
                        disabled={applyingId === turn.commandId}
                        onClick={() => apply(turn.commandId)}
                      >
                        {applyingId === turn.commandId ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          "Apply"
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={applyingId === turn.commandId}
                        onClick={() =>
                          setDismissedIds((prev) =>
                            new Set(prev).add(turn.commandId),
                          )
                        }
                      >
                        Keep discussing
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Discuss the brand&apos;s direction here — ask questions, push back, or
          suggest changes. When we land on something concrete, I&apos;ll propose
          an update you can apply.
        </p>
      )}

      <div className="flex items-start gap-1.5">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. I think our positioning is too generic — let's lean into..."
          className={cn("min-h-16 text-sm")}
          disabled={isSending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={isSending || !input.trim()}
          onClick={send}
        >
          {isSending ? <Loader2 className="size-4 animate-spin" /> : "Send"}
        </Button>
      </div>
    </div>
  );
}
