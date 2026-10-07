"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer } from "react";
import { toast } from "sonner";

import type { SeoRunKind, SeoRunPhase } from "@/lib/module-flows/seo/state";

import { SEO_FLOW_COPY as COPY } from "./copy";

// SC-F6: arka planda süren SEO Manager koşusunun canlı aşamaları. Kart,
// sunucunun DB'yi yoklayan SSE ucuna bağlanır (.../seo/cards/<id>/live?run=<id>):
// `run` olayı aşamayı, `end` olayı sonucu getirir. Bağlantı koparsa 6 sn'de bir
// router.refresh() ile yoklamaya düşer (bugünkü davranış).

export const LIVE_FALLBACK_POLL_MS = 6000;

const PHASES: readonly SeoRunPhase[] = [
  "reading_page",
  "researching",
  "writing",
  "checking",
];
const KINDS: readonly SeoRunKind[] = [
  "research",
  "write",
  "rewrite",
  "snippet",
];

export type LiveState = {
  // Hangi koşunun durumu olduğu; başka koşunun durumu asla gösterilmez.
  runId: string | null;
  kind: SeoRunKind | null;
  phase: SeoRunPhase | null;
  ended: { ok: boolean; message: string | null } | null;
  // SSE koptu: kart 6 sn'de bir yenilenerek izlenir.
  fallback: boolean;
};

export const INITIAL_LIVE_STATE: LiveState = {
  runId: null,
  kind: null,
  phase: null,
  ended: null,
  fallback: false,
};

export type LiveEvent =
  | {
      type: "run";
      running: boolean;
      kind: SeoRunKind | null;
      phase: SeoRunPhase | null;
    }
  | { type: "end"; ok: boolean; message: string | null }
  | { type: "error" };

export type LiveAction = LiveEvent & { runId: string };

// Saf indirgeyici: olay hangi koşuya aitse onun durumunu günceller; başka
// koşunun olayı durumu sıfırdan başlatır.
export function liveStateReducer(
  state: LiveState,
  action: LiveAction,
): LiveState {
  const base: LiveState =
    state.runId === action.runId
      ? state
      : { ...INITIAL_LIVE_STATE, runId: action.runId };
  switch (action.type) {
    case "run":
      // Bitmiş koşuya geç gelen `run` olayı sonucu geri almaz.
      if (base.ended) return base;
      return {
        ...base,
        kind: action.kind ?? base.kind,
        phase: action.running ? (action.phase ?? base.phase) : null,
        fallback: false,
      };
    case "end":
      return {
        ...base,
        phase: null,
        ended: { ok: action.ok, message: action.message },
        fallback: false,
      };
    case "error":
      // Sonuç zaten geldiyse bağlantı kapanması hata değildir.
      return base.ended ? base : { ...base, fallback: true };
  }
}

// Sunucunun bir SSE olayını (ad + JSON gövde) olaya çevirir; bozuk olay null.
export function parseLiveEvent(name: string, raw: string): LiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (name === "run") {
    const kind = KINDS.find((item) => item === record.kind) ?? null;
    const phase = PHASES.find((item) => item === record.phase) ?? null;
    return { type: "run", running: record.running === true, kind, phase };
  }
  if (name === "end") {
    if (typeof record.ok !== "boolean") return null;
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message.slice(0, 300)
        : null;
    return { type: "end", ok: record.ok, message };
  }
  return null;
}

export function liveUrlOf(
  projectId: string,
  commandId: string,
  runId: string,
): string {
  return `/api/projects/${encodeURIComponent(projectId)}/seo/cards/${encodeURIComponent(commandId)}/live?run=${encodeURIComponent(runId)}`;
}

export type SeoLive = {
  phase: SeoRunPhase | null;
  fallback: boolean;
};

export function useSeoLive(input: {
  projectId?: string;
  commandId?: string;
  runId?: string;
  enabled: boolean;
}): SeoLive {
  const { projectId, commandId, runId, enabled } = input;
  const router = useRouter();
  const [state, dispatch] = useReducer(liveStateReducer, INITIAL_LIVE_STATE);
  const active = enabled && Boolean(projectId && commandId && runId);

  useEffect(() => {
    if (!active || !projectId || !commandId || !runId) return;
    if (typeof EventSource === "undefined") {
      dispatch({ type: "error", runId });
      return;
    }
    let finished = false;
    const source = new EventSource(liveUrlOf(projectId, commandId, runId));
    const listen = (name: "run" | "end") => {
      source.addEventListener(name, (event) => {
        const parsed = parseLiveEvent(name, (event as MessageEvent).data);
        if (!parsed) return;
        dispatch({ ...parsed, runId });
        if (parsed.type !== "end") return;
        finished = true;
        source.close();
        if (!parsed.ok) toast.error(parsed.message ?? COPY.liveFailed);
        router.refresh();
      });
    };
    listen("run");
    listen("end");
    source.onerror = () => {
      if (finished) return;
      source.close();
      dispatch({ type: "error", runId });
    };
    return () => {
      finished = true;
      source.close();
    };
  }, [active, projectId, commandId, runId, router]);

  const mine = state.runId === runId ? state : INITIAL_LIVE_STATE;
  const fallback = active && mine.fallback;

  // Bağlantı kopunca ya da hiç kurulamayınca bugünkü 6 sn'lik yoklama.
  useEffect(() => {
    if (!fallback) return;
    const timer = window.setInterval(
      () => router.refresh(),
      LIVE_FALLBACK_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [fallback, router]);

  return { phase: active ? mine.phase : null, fallback };
}
