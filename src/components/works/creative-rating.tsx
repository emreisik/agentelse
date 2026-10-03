"use client";

import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  DISLIKE_REASONS,
  MAX_RATING_NOTE_CHARS,
  type DislikeReasonKey,
} from "@/lib/creative-rating";
import { cn } from "@/lib/utils";
import {
  addLikedCreativeToPostStyleAction,
  rateCreativeAction,
} from "@/server/actions/creative-rating-actions";

// Under a finished post in a Work: one tap to say what the brand should learn
// from it. A like becomes a memory of what worked (and can become an example of
// the brand's Post Style); "not quite" asks what was wrong, in a few taps.

export const CREATIVE_RATING_COPY = {
  like: "Like this post",
  dislike: "Not quite",
  hint: "Teach your brand",
  liked: "Noted: more like this.",
  disliked: "Noted: less like this.",
  addExample: "Use as a style example",
  adding: "Adding…",
  added: "Added to Post style.",
  whatWasWrong: "What was off?",
  noteLabel: "Anything else (optional)",
  send: "Send",
  cancel: "Cancel",
  failed: "That didn't work. Try again.",
} as const;

type Phase = "idle" | "reasons" | "liked" | "disliked";

export function CreativeRating({ creativeId }: { creativeId: string }) {
  const COPY = CREATIVE_RATING_COPY;
  const [phase, setPhase] = useState<Phase>("idle");
  const [reasons, setReasons] = useState<DislikeReasonKey[]>([]);
  const [note, setNote] = useState("");
  const [canAdd, setCanAdd] = useState(false);
  const [added, setAdded] = useState(false);
  const [pending, startTransition] = useTransition();

  const send = (rating: "LIKE" | "DISLIKE") => {
    startTransition(async () => {
      try {
        const result = await rateCreativeAction({
          creativeId,
          rating,
          reasons: rating === "DISLIKE" ? reasons : [],
          note: rating === "DISLIKE" ? note : undefined,
        });
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setCanAdd(result.canAddExample);
        setPhase(rating === "LIKE" ? "liked" : "disliked");
      } catch {
        toast.error(COPY.failed);
      }
    });
  };

  const addExample = () => {
    startTransition(async () => {
      try {
        const result = await addLikedCreativeToPostStyleAction({ creativeId });
        if (result.ok) {
          setAdded(true);
          setCanAdd(false);
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error(COPY.failed);
      }
    });
  };

  const quiet = "var(--ws-text-2)";
  const iconButton =
    "inline-flex size-8 items-center justify-center rounded-lg outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

  if (phase === "liked" || phase === "disliked") {
    return (
      <div
        data-creative-rating
        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        style={{ color: quiet }}
      >
        <span className="inline-flex items-center gap-1.5" role="status">
          <Check aria-hidden className="size-3.5" />
          {phase === "liked" ? COPY.liked : COPY.disliked}
        </span>
        {added ? <span>{COPY.added}</span> : null}
        {phase === "liked" && canAdd ? (
          <button
            type="button"
            disabled={pending}
            onClick={addExample}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-1.5 font-medium underline underline-offset-2 outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{ color: "var(--ws-text)" }}
          >
            {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            {pending ? COPY.adding : COPY.addExample}
          </button>
        ) : null}
      </div>
    );
  }

  if (phase === "reasons") {
    return (
      <div
        data-creative-rating
        className="mt-1.5 space-y-2 rounded-xl border p-2.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <p className="text-xs font-medium" style={{ color: "var(--ws-text)" }}>
          {COPY.whatWasWrong}
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={COPY.whatWasWrong}>
          {DISLIKE_REASONS.map((reason) => {
            const on = reasons.includes(reason.key);
            return (
              <button
                key={reason.key}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setReasons((current) =>
                    on
                      ? current.filter((key) => key !== reason.key)
                      : [...current, reason.key],
                  )
                }
                className={cn(
                  "min-h-8 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  on ? "bg-[var(--ws-hover)]" : "hover:bg-[var(--ws-hover)]",
                )}
                style={{
                  borderColor: on ? "var(--ws-text)" : "var(--ws-border)",
                  color: "var(--ws-text)",
                }}
              >
                {reason.label}
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={note}
          maxLength={MAX_RATING_NOTE_CHARS}
          onChange={(event) => setNote(event.target.value)}
          placeholder={COPY.noteLabel}
          aria-label={COPY.noteLabel}
          className="min-h-9 w-full rounded-lg border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => send("DISLIKE")}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            style={{ background: "var(--ws-text)", color: "var(--ws-surface)" }}
          >
            {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            {COPY.send}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setPhase("idle")}
            className="min-h-9 rounded-lg px-3 text-xs font-medium outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{ color: quiet }}
          >
            {COPY.cancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-creative-rating
      className="mt-1.5 flex items-center gap-1"
      style={{ color: quiet }}
    >
      <button
        type="button"
        aria-label={COPY.like}
        title={COPY.like}
        disabled={pending}
        onClick={() => send("LIKE")}
        className={iconButton}
      >
        {pending ? (
          <Loader2 aria-hidden className="size-4 animate-spin" />
        ) : (
          <ThumbsUp aria-hidden className="size-4" />
        )}
      </button>
      <button
        type="button"
        aria-label={COPY.dislike}
        title={COPY.dislike}
        disabled={pending}
        onClick={() => setPhase("reasons")}
        className={iconButton}
      >
        <ThumbsDown aria-hidden className="size-4" />
      </button>
      <span className="ml-1 text-[11px]">{COPY.hint}</span>
    </div>
  );
}
