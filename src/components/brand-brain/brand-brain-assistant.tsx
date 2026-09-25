"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { HelpCircle, Loader2, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { CONSTITUTION_SECTIONS } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  applyBrandBrainRevisionAction,
  getBrandBrainChatHistoryAction,
  sendBrandBrainMessageAction,
  type BrandBrainChatTurn,
} from "@/server/actions/brand-brain-actions";

const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  CONSTITUTION_SECTIONS.map((s) => [s.key, s.label]),
);

// Global standing conversation to discuss/challenge/refine the brand's
// constitution and strategy — mounted once from AppShell (app-shell.tsx) so
// it floats bottom-right on every screen of the project, not just the Brand
// Brain panel. Collapsed by default; history is fetched lazily on first
// expand via getBrandBrainChatHistoryAction, since AppShell renders on every
// navigation and eagerly fetching the thread there would tax every page
// load whether or not the assistant is ever opened.
// When the assistant proposes a concrete direction it can also ask via
// `questions` — 1-2 short questions with 2-4 pickable options (mirrors
// Claude Code's own AskUserQuestion UX) — before landing on a revision the
// client applies. Modeled on Claude Code's own plan -> approve loop:
// narrate freely, only ask for a decision once there's something concrete.
export function BrandBrainAssistant({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<BrandBrainChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [isSending, startSending] = useTransition();
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [multiSelectDraft, setMultiSelectDraft] = useState<
    Record<string, string[]>
  >({});

  const openWidget = () => {
    setOpen(true);
    if (loaded || loading) return;
    setLoading(true);
    getBrandBrainChatHistoryAction(projectId)
      .then((result) => {
        if (result.ok) {
          setTurns(result.turns);
          setLoaded(true);
        } else {
          toast.error(result.message);
        }
      })
      .finally(() => setLoading(false));
  };

  const sendMessage = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setInput("");
    startSending(async () => {
      const result = await sendBrandBrainMessageAction(projectId, trimmed);
      if (!result.ok) {
        toast.error(result.message);
        setInput(trimmed);
        return;
      }
      setTurns((prev) => [
        ...prev,
        {
          commandId: result.commandId,
          source: "WEB",
          text: trimmed,
          reply: result.reply,
          questions: result.questions,
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

  const toggleMultiOption = (key: string, label: string) => {
    setMultiSelectDraft((prev) => {
      const current = prev[key] ?? [];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...prev, [key]: next };
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={openWidget}
        aria-label="Brand Brain Assistant"
        className={cn(
          "group flex size-14 items-center justify-center rounded-full",
          "bg-gradient-to-br from-neutral-800 via-neutral-950 to-black shadow-lg shadow-black/30",
          "ring-1 ring-white/10 transition-transform hover:scale-105 active:scale-95",
        )}
      >
        <Sparkles className="size-5 text-white" />
      </button>
    );
  }

  const lastTurnId =
    turns.length > 0 ? turns[turns.length - 1]!.commandId : null;

  return (
    <div className="flex h-[32rem] w-96 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">
            Brand Brain Assistant
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(false)}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : turns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Discuss the brand&apos;s direction here — ask questions, push back,
            or suggest changes. When we land on something concrete, I&apos;ll
            propose an update you can apply.
          </p>
        ) : (
          turns.map((turn) => (
            <div key={turn.commandId} className="space-y-1.5">
              {turn.text ? (
                <p className="text-sm text-foreground">{turn.text}</p>
              ) : null}
              {turn.reply ? (
                <p className="text-sm whitespace-pre-line text-muted-foreground">
                  {turn.reply}
                </p>
              ) : null}

              {turn.questions?.map((q, qIndex) => {
                const key = `${turn.commandId}-${qIndex}`;
                const interactive = turn.commandId === lastTurnId;
                const selected = multiSelectDraft[key] ?? [];
                return (
                  <div
                    key={key}
                    className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
                  >
                    <p className="flex items-start gap-1.5 text-xs font-medium text-foreground">
                      <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      {q.question}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {q.options.map((option) => {
                        const isSelected = selected.includes(option.label);
                        return (
                          <button
                            key={option.label}
                            type="button"
                            disabled={!interactive || isSending}
                            title={option.description}
                            onClick={() =>
                              q.multiSelect
                                ? toggleMultiOption(key, option.label)
                                : sendMessage(`${q.question}: ${option.label}`)
                            }
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background text-foreground hover:bg-accent",
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    {q.multiSelect && interactive ? (
                      <Button
                        type="button"
                        size="xs"
                        disabled={selected.length === 0 || isSending}
                        onClick={() =>
                          sendMessage(`${q.question}: ${selected.join(", ")}`)
                        }
                      >
                        Continue
                      </Button>
                    ) : null}
                  </div>
                );
              })}

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
          ))
        )}
      </div>

      <div className="flex shrink-0 items-start gap-1.5 border-t border-border p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. I think our positioning is too generic — let's lean into..."
          className="min-h-16 text-sm"
          disabled={isSending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage(input);
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={isSending || !input.trim()}
          onClick={() => sendMessage(input)}
        >
          {isSending ? <Loader2 className="size-4 animate-spin" /> : "Send"}
        </Button>
      </div>
    </div>
  );
}
