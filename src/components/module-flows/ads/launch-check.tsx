"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { CardActions } from "@/components/works/card-actions";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  PREVIEW_LABEL,
  type AdsLaunchCheck,
} from "@/lib/module-flows/ads/launch";
import { prepareAdsLaunchAction } from "@/server/actions/ads-launch-actions";

import { LoadingLine } from "./parts";

// Güvenli lansman v2'nin Review bölümü (docs/meta-ads-plan.md F3): Meta'nın ön
// kontrolü (yerel kurallar + validate_only), önizlemeler, net zarf, tempo,
// harcama tavanı ve bitiş. Bayrak kapalıysa (V2_OFF) eski Review kalır.

const COPY = ADS_FLOW_COPY;
const VIDEO_POLL_MS = 15_000;

export type LaunchCheckState =
  // Henüz sorulmadı (sunucu çizimi): eski Review görünür.
  | { status: "idle" }
  | { status: "loading" }
  | { status: "off" }
  | { status: "ready"; check: AdsLaunchCheck }
  | { status: "error"; message: string };

export function useLaunchCheck(
  projectId: string,
  commandId: string,
  enabled: boolean,
): { state: LaunchCheckState; reload: () => void } {
  const [state, setState] = useState<LaunchCheckState>({ status: "idle" });
  const [, startChecking] = useTransition();
  const live = useRef(true);
  const run = useCallback(async (quiet = false) => {
    // Sessiz yoklama (video işlenirken) ekranı "kontrol ediliyor"a çevirmez.
    if (!quiet) setState({ status: "loading" });
    const result = await prepareAdsLaunchAction(projectId, commandId).catch(
      () => null,
    );
    if (!live.current) return;
    if (!result) {
      setState({ status: "error", message: COPY.checkFailed });
    } else if (result.ok) {
      setState({ status: "ready", check: result.check });
    } else if (result.code === "V2_OFF") {
      setState({ status: "off" });
    } else {
      setState({
        status: "error",
        message: result.message || COPY.checkFailed,
      });
    }
  }, [projectId, commandId]);
  useEffect(() => {
    live.current = true;
    if (enabled) startChecking(() => run());
    return () => {
      live.current = false;
    };
  }, [enabled, run]);
  // Video reklam: Meta videoyu işlerken kontrol 15 sn'de bir kendiliğinden
  // yenilenir (her yoklama yalnız durumu sorar).
  const waiting = state.status === "ready" && state.check.processing === true;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => startChecking(() => run(true)), VIDEO_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, state, run]);
  return { state, reload: () => void run() };
}

export function LaunchCheckPanel({
  state,
  onRetry,
}: {
  state: LaunchCheckState;
  onRetry: () => void;
}) {
  if (state.status === "off" || state.status === "idle") return null;
  if (state.status === "loading") {
    return <LoadingLine className="py-1">{COPY.checkingMeta}</LoadingLine>;
  }
  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm" style={{ color: "var(--ws-text)" }}>
          {state.message}
        </p>
        <CardActions
          buttons={[
            {
              id: "check:retry",
              label: COPY.retry,
              emphasis: "secondary",
              action: { kind: "server", id: "check:retry" },
            },
          ]}
          busyId={null}
          onAct={onRetry}
        />
      </div>
    );
  }
  const { check } = state;
  const blocking = check.issues.filter((issue) => issue.severity === "block");
  const warnings = check.issues.filter((issue) => issue.severity === "warn");
  return (
    <div className="space-y-3">
      {blocking.length === 0 ? (
        <p
          className="flex items-center gap-1.5 text-sm"
          style={{ color: "var(--ws-approved)" }}
          role="status"
        >
          <CheckCircle2 aria-hidden="true" className="size-4" />
          {COPY.metaChecked}
        </p>
      ) : null}
      {[...blocking, ...warnings].length > 0 ? (
        <ul className="space-y-1.5">
          {[...blocking, ...warnings].map((issue) => (
            <li
              key={`${issue.field}:${issue.message}`}
              className="flex items-start gap-2 rounded-xl border px-2.5 py-2 text-sm"
              style={{
                borderColor:
                  issue.severity === "block"
                    ? "var(--destructive)"
                    : "var(--ws-border)",
                color: "var(--ws-text)",
              }}
            >
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
                style={{
                  color:
                    issue.severity === "block"
                      ? "var(--destructive)"
                      : "var(--ws-text-2)",
                }}
              />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {check.previews.length > 0 ? (
        <div className="space-y-1.5">
          <p
            className="text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.previews}
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {check.previews.map((preview) => (
              <figure key={preview.format} className="shrink-0 space-y-1">
                <iframe
                  title={PREVIEW_LABEL[preview.format] ?? preview.format}
                  src={preview.src}
                  sandbox="allow-scripts allow-same-origin"
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="h-[420px] w-[260px] rounded-xl border"
                  style={{ borderColor: "var(--ws-border)" }}
                />
                <figcaption
                  className="text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {PREVIEW_LABEL[preview.format] ?? preview.format}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ) : null}
      {check.reach || check.expected ? (
        <div className="space-y-0.5 text-sm" style={{ color: "var(--ws-text)" }}>
          {check.reach ? <p>{check.reach}</p> : null}
          {check.expected ? <p>{check.expected}</p> : null}
        </div>
      ) : null}
      <div className="space-y-1 text-xs" style={{ color: "var(--ws-text-2)" }}>
        {check.adding ? (
          <p>{COPY.addsToExisting}</p>
        ) : (
          <>
            <p>{COPY.envelope(check.envelope)}</p>
            {check.gross ? <p>{COPY.gross(check.gross)}</p> : null}
            <p>{COPY.pacing}</p>
            {check.spendCap ? <p>{COPY.spendCap(check.spendCap)}</p> : null}
            <p>{COPY.endsOn(check.endsOn)}</p>
          </>
        )}
        {check.featuresFallback ? <p>{COPY.featuresOff}</p> : null}
        {check.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    </div>
  );
}
