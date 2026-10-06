"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BellOff, CirclePause, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  muteAdsAlertAction,
  pauseAllAdsAction,
  refreshAdsMirrorAction,
} from "@/server/actions/ads-guard-actions";
import { cn } from "@/lib/utils";

// Ads account başlığı (docs/meta-ads-plan.md §3.8, F2): hesap sağlığı, ayna
// tazeliği ("Updated 12 min ago · Account time"), Refresh, Pause all ve açık
// uyarılar. Veriler aynadandır; Meta'ya yalnız Refresh gider.

export type AdsStatusAlert = {
  id: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  title: string;
  detail: string | null;
};

export type AdsAccountStatusProps = {
  projectId: string;
  healthStatus: string;
  healthReason: string | null;
  updatedText: string | null;
  // "Account time (Europe/Istanbul)" — yalnız proje saatinden farklıysa.
  accountTimeLabel: string | null;
  runningCampaigns: number;
  alerts: AdsStatusAlert[];
  // F7: webhook aboneliği. "polling" = hesapta admin yok, uyarılar yoklamayla
  // (en geç ~1 saat) gelir; null = webhook kapalı ya da henüz denenmedi.
  realtime?: "on" | "polling" | null;
  // F8: ajans görünümüne (/ads) bağlantı.
  agencyLink?: boolean;
};

const SEVERITY_TONE: Record<AdsStatusAlert["severity"], string> = {
  CRITICAL: "border-destructive/40 bg-destructive/5 text-destructive",
  WARN: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  INFO: "border-border bg-muted/40 text-muted-foreground",
};

function healthText(status: string, reason: string | null): string {
  if (status === "OK") return "Account healthy";
  if (status === "AUTH") return "Reconnect Meta Ads";
  if (status === "UNKNOWN") return "Checking account…";
  return reason ?? "Needs attention";
}

export function AdsAccountStatus(props: AdsAccountStatusProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refresh = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await refreshAdsMirrorAction(props.projectId);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.state === "refreshed") router.refresh();
      setMessage(
        result.state === "throttled"
          ? "Updated a few minutes ago. Try again shortly."
          : result.state === "busy"
            ? "An update is already running."
            : result.state === "unavailable"
              ? "Live numbers aren't available for this account yet."
              : null,
      );
    });

  const pauseAll = () =>
    startTransition(async () => {
      setConfirming(false);
      setMessage(null);
      const result = await pauseAllAdsAction(props.projectId);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage(
        result.message ??
          (result.paused === 0
            ? "Nothing was running."
            : `Paused ${result.paused} campaign${result.paused === 1 ? "" : "s"}${result.failed ? `; ${result.failed} couldn't be paused` : ""}.`),
      );
      router.refresh();
    });

  const mute = (alertId: string) =>
    startTransition(async () => {
      await muteAdsAlertAction(props.projectId, alertId);
      router.refresh();
    });

  const healthy = props.healthStatus === "OK";
  return (
    <section className="space-y-3" aria-label="Ad account status">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 font-medium",
              healthy ? "text-foreground" : "text-destructive",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                healthy ? "bg-emerald-500" : "bg-destructive",
              )}
            />
            {healthText(props.healthStatus, props.healthReason)}
          </span>
          {props.updatedText ? (
            <span className="text-muted-foreground">
              {props.updatedText}
              {props.accountTimeLabel ? ` · ${props.accountTimeLabel}` : ""}
            </span>
          ) : null}
          {props.agencyLink ? (
            <Link href="/ads" className="text-muted-foreground underline-offset-2 hover:underline">
              All ad accounts
            </Link>
          ) : null}
          {props.realtime === "on" ? (
            <span className="text-muted-foreground">Real-time alerts on</span>
          ) : props.realtime === "polling" ? (
            <span className="text-muted-foreground">
              Real-time alerts need an admin of this ad account
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={pending}
            className="gap-1.5"
          >
            <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
            Refresh
          </Button>
          {props.runningCampaigns > 0 ? (
            confirming ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={pauseAll}
                  disabled={pending}
                >
                  Pause {props.runningCampaigns} campaign
                  {props.runningCampaigns === 1 ? "" : "s"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirming(true)}
                disabled={pending}
                className="gap-1.5"
              >
                <CirclePause className="size-3.5" />
                Pause all
              </Button>
            )
          ) : null}
        </div>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {props.alerts.length > 0 ? (
        <ul className="space-y-2">
          {props.alerts.map((alert) => (
            <li
              key={alert.id}
              className={cn(
                "flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm",
                SEVERITY_TONE[alert.severity],
              )}
            >
              <div className="flex min-w-0 gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{alert.title}</p>
                  {alert.detail ? (
                    <p className="text-muted-foreground">{alert.detail}</p>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 gap-1 text-muted-foreground"
                onClick={() => mute(alert.id)}
                disabled={pending}
                aria-label={`Mute "${alert.title}" for 7 days`}
              >
                <BellOff className="size-3.5" />
                Mute
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
