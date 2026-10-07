"use client";

import { Loader2 } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { toast } from "sonner";

import { useCardAction } from "@/components/works/use-card-action";
import type { ModuleFlowStep } from "@/lib/module-flows/card";
import {
  seoModeOf,
  type SeoRunKind,
  type SeoRunPhase,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { cn } from "@/lib/utils";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import {
  researchSeoAction,
  rewriteSeoArticleAction,
  writeSeoArticleAction,
  type SeoFlowResult,
} from "@/server/actions/seo-flow-actions";
import {
  researchRefreshAction,
  suggestSnippetAction,
} from "@/server/actions/seo-mode-actions";

import { SEO_FLOW_COPY } from "./copy";

// Small parts every step of the SEO Manager's card shares.

// What every step's server button answers: the card refreshes after a write
// (the action revalidated the page; the refresh makes sure this card follows).
export function toCardResult(result: SeoFlowResult): CardActionResult {
  return result.ok
    ? {
        ok: true,
        refresh: true,
        ...(result.message ? { message: result.message } : {}),
      }
    : {
        ok: false,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
      };
}

// Tells the card which step a tap is moving it to, so the stepper moves at
// once (a research or a writing takes a minute); null when the tap failed.
export type OnMoving = (to: ModuleFlowStep | null) => void;

// The button row of a step: its server buttons (each answer refreshes the
// card), the steps they move to, and the buttons that only change the view.
export function useSeoStepAction(input: {
  projectId?: string;
  commandId?: string;
  onMoving?: OnMoving;
  moves?: Readonly<Partial<Record<string, ModuleFlowStep>>>;
  local?: Readonly<Partial<Record<string, () => void>>>;
  server: (
    id: string,
    card: { projectId: string; commandId: string },
  ) => Promise<SeoFlowResult>;
}): {
  onAct: (button: CardButton) => void;
  busyId: string | null;
  error: string | null;
} {
  const { projectId, commandId, onMoving, moves, local, server } = input;
  const action = useCardAction({
    server: async (id) => {
      const result: SeoFlowResult =
        projectId && commandId
          ? await server(id, { projectId, commandId })
          : { ok: false, message: SEO_FLOW_COPY.unavailable };
      if (!result.ok) onMoving?.(null);
      return toCardResult(result);
    },
  });
  const onAct = (button: CardButton) => {
    const view = local?.[button.id];
    if (view) {
      view();
      return;
    }
    const to = moves?.[button.id];
    if (to) onMoving?.(to);
    action.run(button);
  };
  return { onAct, busyId: action.busyId, error: action.error };
}

// A server button of a step's row, blocked with its reason when there is one.
export function serverButton(
  id: string,
  label: string,
  emphasis: CardButton["emphasis"],
  reason: string | null,
): CardButton {
  return {
    id,
    label,
    emphasis,
    action: { kind: "server", id },
    ...(reason ? { disabledReason: reason } : {}),
  };
}

// SC-F6: durmuş bir koşunun yeniden denenmesi; hangi eylemin çağrılacağı koşu
// türünden ve kartın kipinden çıkar. Kartta gereken veri yoksa denenemez.
export function retryRun(
  state: SeoState,
  kind: SeoRunKind,
  card: { projectId: string; commandId: string },
): Promise<SeoFlowResult> {
  const unavailable = Promise.resolve<SeoFlowResult>({
    ok: false,
    message: SEO_FLOW_COPY.unavailable,
  });
  const mode = seoModeOf(state);
  const url = state.target?.url;
  const language = state.brief?.language;
  switch (kind) {
    case "research":
      if (mode === "refresh") {
        return url && language
          ? researchRefreshAction(card.projectId, card.commandId, {
              url,
              language,
            })
          : unavailable;
      }
      return mode === "article"
        ? researchSeoAction(card.projectId, card.commandId)
        : unavailable;
    case "snippet":
      return url && language
        ? suggestSnippetAction(card.projectId, card.commandId, {
            url,
            language,
          })
        : unavailable;
    case "write":
      return writeSeoArticleAction(card.projectId, card.commandId);
    case "rewrite":
      return rewriteSeoArticleAction(card.projectId, card.commandId);
  }
}

export function copyToClipboard(text: string, what: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    toast.error(SEO_FLOW_COPY.copyFailed);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success(SEO_FLOW_COPY.copied(what)),
    () => toast.error(SEO_FLOW_COPY.copyFailed),
  );
}

// A model call at work: calm, visible, announced once.
export function WorkingNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border px-3 py-2.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface-2)",
      }}
    >
      <Loader2
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
        style={{ color: "var(--ws-text-2)" }}
      />
      <p className="text-sm leading-5" style={{ color: "var(--ws-text-2)" }}>
        {children}
      </p>
    </div>
  );
}

// A labelled part of a step's body.
export function Field({
  label,
  htmlFor,
  aside,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const text = (
    <span className="text-xs font-medium" style={{ color: "var(--ws-text-2)" }}>
      {label}
    </span>
  );
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        {htmlFor ? <label htmlFor={htmlFor}>{text}</label> : text}
        {aside}
      </div>
      {children}
    </div>
  );
}

// SC-F6: canlı koşunun aşaması (SSE). Kart sağlayıcıyı yalnız canlı özellik
// açıkken doldurur; yoksa RunNote eskisi gibi düz metin gösterir.
const LivePhaseContext = createContext<SeoRunPhase | null>(null);
export const LivePhaseProvider = LivePhaseContext.Provider;

// Çalışan bir model çağrısının notu: canlı aşama varsa onu söyler, yoksa
// verilen düz metni.
export function RunNote({ text }: { text: string }) {
  const phase = useContext(LivePhaseContext);
  return (
    <WorkingNote>{phase ? SEO_FLOW_COPY.phase[phase] : text}</WorkingNote>
  );
}

export const NATIVE_SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30";
