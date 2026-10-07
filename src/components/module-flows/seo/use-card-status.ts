"use client";

import { useCallback, useEffect, useState } from "react";

import { isSeoActionStatus, isSeoFixKind } from "@/lib/seo/actions/kinds";
import type { SeoCardStatus } from "@/server/modules/seo/card-status";

// SC-F6: kartın takvim parçası + eylem durumu (Deliver ve Brief adımları
// ortak okur). Ucu önbelleksizdir; kart değişince (version) ve elle
// (reload) yeniden okunur. Okunamazsa durum null kalır, kart çizilmeye devam eder.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Ucun JSON'unu gevşekçe okur: tanınmayan parça atılır, bozuk gövde null olur.
export function parseCardStatus(value: unknown): SeoCardStatus | null {
  const root = asRecord(value);
  if (!root) return null;

  const pieceRaw = asRecord(root.piece);
  const piece =
    pieceRaw &&
    typeof pieceRaw.status === "string" &&
    typeof pieceRaw.label === "string"
      ? {
          status: pieceRaw.status,
          label: pieceRaw.label,
          at: textOrNull(pieceRaw.at),
        }
      : null;

  const actionRaw = asRecord(root.action);
  let action: SeoCardStatus["action"] = null;
  if (
    actionRaw &&
    typeof actionRaw.id === "string" &&
    isSeoFixKind(actionRaw.kind) &&
    isSeoActionStatus(actionRaw.status) &&
    typeof actionRaw.statusLabel === "string"
  ) {
    const can = asRecord(actionRaw.can);
    action = {
      id: actionRaw.id,
      kind: actionRaw.kind,
      status: actionRaw.status,
      statusLabel: actionRaw.statusLabel,
      headline: textOrNull(actionRaw.headline),
      detail: textOrNull(actionRaw.detail),
      ask: textOrNull(actionRaw.ask),
      evaluateAfter: textOrNull(actionRaw.evaluateAfter),
      can: {
        confirmLive: can?.confirmLive === true,
        checkNow: can?.checkNow === true,
        undo: can?.undo === true,
      },
    };
  }

  const suggestionRaw = asRecord(root.suggestion);
  const topic = suggestionRaw ? textOrNull(suggestionRaw.topic) : null;

  return {
    piece,
    action,
    suggestion: topic ? { topic } : null,
    removed: root.removed === true,
  };
}

export function cardStatusUrl(projectId: string, commandId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/seo/cards/${encodeURIComponent(commandId)}/status`;
}

export function useCardStatus(input: {
  projectId?: string;
  commandId?: string;
  enabled: boolean;
  // Kart değişince yeniden okutan imza (ör. teslim/uygulandı alanları).
  version: string;
}): { status: SeoCardStatus | null; reload: () => void } {
  const { projectId, commandId, enabled, version } = input;
  const [loaded, setLoaded] = useState<{
    key: string;
    status: SeoCardStatus | null;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${projectId ?? ""}|${commandId ?? ""}`;

  useEffect(() => {
    if (!enabled || !projectId || !commandId) return;
    const controller = new AbortController();
    fetch(cardStatusUrl(projectId, commandId), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ key, status: parseCardStatus(body) });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, projectId, commandId, key, version, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return {
    status: enabled && loaded?.key === key ? loaded.status : null,
    reload,
  };
}
