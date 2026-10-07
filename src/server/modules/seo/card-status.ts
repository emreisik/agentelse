import "server-only";

import { prisma } from "@/lib/prisma";
import { formatWhen } from "@/lib/module-flows/seo/deliver";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import {
  ACTION_STATUS_LABEL,
  askText,
  outcomeDetail,
  outcomeHeadline,
} from "@/lib/seo/actions/copy";
import {
  OPEN_ACTION_STATUSES,
  type SeoActionStatus,
  type SeoFixKind,
} from "@/lib/seo/actions/kinds";
import type { SeoActionView } from "@/lib/seo/actions/types";
import { readSeoCard } from "@/server/modules/seo/card";
import { seoPieceStatus } from "@/server/modules/seo/calendar";
import { actionForCard, getAction } from "@/server/seo/actions/store";

// SEO Manager kartının Deliver adımının durumu (docs/search-actions.md "SEO
// Manager"): takvimdeki parçanın durumu, kartın eyleminin durumu/sonucu ve
// Fix this'ten gelen konu önerisi. Kartın kendisi (sunucu bileşeni) bunları
// bilmez; istemci bu uçtan okur, hiçbir yerde önbelleklenmez.

export type SeoCardStatus = {
  piece: { status: string; label: string; at: string | null } | null;
  action: {
    id: string;
    kind: SeoFixKind;
    status: SeoActionStatus;
    statusLabel: string;
    headline: string | null;
    detail: string | null;
    ask: string | null;
    evaluateAfter: string | null;
    can: { confirmLive: boolean; checkNow: boolean; undo: boolean };
  } | null;
  suggestion: { topic: string } | null;
  removed: boolean;
};

const EVALUATED: readonly SeoActionStatus[] = [
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
];

async function pieceOf(
  projectId: string,
  delivery: { creativeId: string; scheduledFor: string; timezone: string },
): Promise<NonNullable<SeoCardStatus["piece"]>> {
  const status = await seoPieceStatus(projectId, delivery.creativeId);
  if (!status) {
    return { status: "REMOVED", label: "Removed from calendar", at: null };
  }
  // Takvimde sürüklenmiş olabilir: gün her zaman parçanın kendi saatinden.
  const creative = await prisma.creative.findFirst({
    where: { id: delivery.creativeId, projectId },
    select: { scheduledFor: true },
  });
  const at = (
    creative?.scheduledFor ?? new Date(delivery.scheduledFor)
  ).toISOString();
  if (status === "PUBLISHED") return { status, label: "Published", at };
  return {
    status,
    label: `On calendar for ${formatWhen(at, delivery.timezone)}`,
    at,
  };
}

function actionOf(action: SeoActionView): NonNullable<SeoCardStatus["action"]> {
  const evaluated =
    EVALUATED.includes(action.status) && action.evaluation !== null;
  const open = action.status === "APPLIED" || action.status === "VERIFIED";
  return {
    id: action.id,
    kind: action.kind,
    status: action.status,
    statusLabel: ACTION_STATUS_LABEL[action.status],
    headline:
      evaluated && action.evaluation
        ? outcomeHeadline(action.evaluation)
        : null,
    detail:
      evaluated && action.evaluation ? outcomeDetail(action.evaluation) : null,
    ask: action.askedAt && open ? askText(action.kind) : null,
    evaluateAfter: action.evaluateAfter?.toISOString() ?? null,
    can: {
      confirmLive: action.status === "APPLIED",
      checkNow: open,
      undo: action.status === "APPLIED",
    },
  };
}

export async function loadSeoCardStatus(
  projectId: string,
  commandId: string,
): Promise<SeoCardStatus | null> {
  const read = await readSeoCard(projectId, commandId);
  if (!read) return null;
  const { state, step } = read;

  const piece = state.delivery
    ? await pieceOf(projectId, state.delivery)
    : null;

  // Eylem satırları yalnız eylem döngüsü açıkken okunur; kapalıyken kartın
  // actionId'si "silinmiş" sayılmaz.
  let action: SeoActionView | null = null;
  if (SeoActionFlags.loop()) {
    action = state.actionId
      ? await getAction(projectId, state.actionId)
      : await actionForCard(projectId, commandId);
  }
  const removed = SeoActionFlags.loop() && Boolean(state.actionId) && !action;

  // Fix this'ten gelen konu önerisi: Brief'te, konu boşken, açık NEW_CONTENT /
  // LOCALIZE eyleminin anahtar kelimesi. Kartın kendisine yazılmaz; kullanıcı
  // tek dokunuşla benimser.
  let suggestion: SeoCardStatus["suggestion"] = null;
  if (
    action &&
    (action.kind === "NEW_CONTENT" || action.kind === "LOCALIZE") &&
    OPEN_ACTION_STATUSES.includes(action.status) &&
    step === "brief" &&
    !(state.brief?.topic ?? "").trim() &&
    (action.proposal.kind === "NEW_CONTENT" ||
      action.proposal.kind === "LOCALIZE") &&
    action.proposal.primaryKeyword
  ) {
    suggestion = { topic: action.proposal.primaryKeyword };
  }

  return {
    piece,
    action: action ? actionOf(action) : null,
    suggestion,
    removed,
  };
}
