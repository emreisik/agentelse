"use client";

import { CalendarCheck, Search } from "lucide-react";

import { CardActions } from "@/components/works/card-actions";
import { formatDay } from "@/lib/module-flows/seo/deliver";
import type { SeoActionStatus } from "@/lib/seo/actions/kinds";
import type { CardButton } from "@/lib/works/card-action";
import {
  checkSeoNowAction,
  confirmSeoLiveAction,
  undoSeoAppliedAction,
} from "@/server/actions/seo-mode-actions";
import type { SeoCardStatus } from "@/server/modules/seo/card-status";

import { SEO_FLOW_COPY as COPY } from "./copy";
import { serverButton, useSeoStepAction } from "./parts";

// SC-F6: Deliver adımının "ne oldu" bölümü. Takvim parçasının durumu, bağlı
// eylemin (SeoAction) durumu, sonucu ya da sorusu ve soruya verilecek cevap
// düğmeleri. Metinleri sunucu hazırlar (şablon, rakam anlatısı yok); burası
// yalnız çizer. cardStatusView saf ve sınanabilirdir.

const LIVE = "live";
const CHECK = "check";
const UNDO = "undo";

export type CardStatusButtonId = typeof LIVE | typeof CHECK | typeof UNDO;
export type StatusTone = "positive" | "waiting" | "neutral";

export type CardStatusView = {
  piece: { label: string } | null;
  action: {
    statusLabel: string;
    tone: StatusTone;
    headline: string | null;
    detail: string | null;
    ask: string | null;
    measuringUntil: string | null;
    buttons: { id: CardStatusButtonId; label: string }[];
  } | null;
  removed: boolean;
  // "Suggested from Search Console" konusu: yalnız modlar açıkken.
  suggestion: string | null;
};

const TONE: Readonly<Record<SeoActionStatus, StatusTone>> = {
  PROPOSED: "neutral",
  ACCEPTED: "neutral",
  APPLIED: "waiting",
  VERIFIED: "waiting",
  EVALUATING: "waiting",
  WORKED: "positive",
  DIDNT: "neutral",
  INCONCLUSIVE: "neutral",
  DISMISSED: "neutral",
  EXPIRED: "neutral",
};

export function cardStatusView(
  status: SeoCardStatus | null,
  options: { modes: boolean; timezone?: string },
): CardStatusView | null {
  if (!status) return null;
  const { action } = status;
  const buttons: { id: CardStatusButtonId; label: string }[] = [];
  if (action?.can.confirmLive) buttons.push({ id: LIVE, label: COPY.itsLive });
  if (action?.can.checkNow) buttons.push({ id: CHECK, label: COPY.checkAgain });
  if (action?.can.undo) buttons.push({ id: UNDO, label: COPY.notDoneYet });

  const until =
    action?.status === "EVALUATING" && action.evaluateAfter
      ? formatDay(action.evaluateAfter, options.timezone)
      : "";

  return {
    piece: status.piece ? { label: status.piece.label } : null,
    action: action
      ? {
          statusLabel: action.statusLabel,
          tone: TONE[action.status],
          headline: action.headline,
          detail: action.detail,
          ask: action.ask,
          measuringUntil: until ? COPY.measuringUntil(until) : null,
          buttons,
        }
      : null,
    removed: status.removed,
    suggestion:
      options.modes && status.suggestion ? status.suggestion.topic : null,
  };
}

const DOT: Readonly<Record<StatusTone, string>> = {
  positive: "var(--ws-approved)",
  waiting: "var(--ws-pending)",
  neutral: "var(--ws-text-3)",
};

const BUTTON_EMPHASIS: Readonly<
  Record<CardStatusButtonId, CardButton["emphasis"]>
> = { live: "primary", check: "secondary", undo: "quiet" };

export function CardStatus({
  projectId,
  commandId,
  status,
  blocked,
  timezone,
  modes,
  onChanged,
}: {
  projectId?: string;
  commandId?: string;
  status: SeoCardStatus | null;
  blocked: string | null;
  timezone?: string;
  modes: boolean;
  // Bir cevaptan sonra durumu yeniden okutur.
  onChanged: () => void;
}) {
  const view = cardStatusView(status, { modes, timezone });
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    server: async (id, card) => {
      const result =
        id === LIVE
          ? await confirmSeoLiveAction(card.projectId, card.commandId)
          : id === CHECK
            ? await checkSeoNowAction(card.projectId, card.commandId)
            : await undoSeoAppliedAction(card.projectId, card.commandId);
      onChanged();
      return result;
    },
  });
  if (!view || (!view.piece && !view.action && !view.removed)) return null;

  const { action } = view;
  const buttons: CardButton[] = (action?.buttons ?? []).map((button) =>
    serverButton(button.id, button.label, BUTTON_EMPHASIS[button.id], blocked),
  );

  return (
    <div
      className="space-y-2.5 border-t pt-3"
      style={{ borderColor: "var(--ws-border)" }}
      aria-live="polite"
    >
      {view.piece ? (
        <p
          className="flex items-center gap-1.5 text-sm"
          style={{ color: "var(--ws-text)" }}
        >
          <CalendarCheck
            aria-hidden="true"
            className="size-4 shrink-0"
            style={{ color: "var(--ws-text-2)" }}
          />
          {view.piece.label}
        </p>
      ) : null}

      {action ? (
        <div className="space-y-1.5">
          <p
            className="flex items-center gap-1.5 text-sm"
            style={{ color: "var(--ws-text)" }}
          >
            <Search
              aria-hidden="true"
              className="size-4 shrink-0"
              style={{ color: "var(--ws-text-2)" }}
            />
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: DOT[action.tone] }}
            />
            <span className="font-medium">{action.statusLabel}</span>
          </p>
          {action.headline ? (
            <p
              className="text-sm leading-5 font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {action.headline}
            </p>
          ) : null}
          {action.detail ? (
            <p
              className="text-xs leading-5"
              style={{ color: "var(--ws-text-2)" }}
            >
              {action.detail}
            </p>
          ) : null}
          {action.measuringUntil ? (
            <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
              {action.measuringUntil}
            </p>
          ) : null}
          {action.ask ? (
            <p
              className="text-sm leading-5"
              style={{ color: "var(--ws-text)" }}
            >
              {action.ask}
            </p>
          ) : null}
          {buttons.length > 0 ? (
            <CardActions
              buttons={buttons}
              onAct={onAct}
              busyId={busyId}
              error={error}
            />
          ) : null}
        </div>
      ) : null}

      {view.removed ? (
        <p className="text-xs leading-5" style={{ color: "var(--ws-text-3)" }}>
          {COPY.resultsRemoved}
        </p>
      ) : null}
    </div>
  );
}
