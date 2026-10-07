"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionForm } from "@/components/shared/action-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createWebsiteReportShareAction,
  revokeWebsiteReportShareAction,
} from "@/server/actions/website-client-report-actions";
import type { ReportShareView } from "@/server/report-share/store";

import { CopyField } from "./copy-field";

// Bir haftalık/aylık raporun müşteri bağlantıları (GA-F8): oluştur (açık onay
// kutusuyla), adresi BİR KEZ göster, mevcutları listele ve iptal et. Adres
// yalnız bu bileşenin durumunda yaşar; sayfa yenilenince bir daha görünmez.

const DAY_OPTIONS = [7, 30, 90] as const;

const STATUS_LABEL: Record<ReportShareView["status"], string> = {
  ACTIVE: "Active",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

const STATUS_CLASS: Record<ReportShareView["status"], string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  EXPIRED: "bg-muted text-muted-foreground",
  REVOKED: "bg-muted text-muted-foreground",
};

function dayText(iso: string): string {
  return iso.slice(0, 10);
}

export function SharePanel({
  projectId,
  commandId,
  shares,
}: {
  projectId: string;
  commandId: string;
  shares: ReportShareView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    startTransition(async () => {
      const result = await createWebsiteReportShareAction(data);
      if (result.ok) {
        setCreated({ url: result.url, expiresAt: result.expiresAt });
        form.reset();
        toast.success("Client link created");
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <form onSubmit={onSubmit} className="space-y-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="commandId" value={commandId} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor={`days-${commandId}`}>
            Link works for
          </label>
          <select
            id={`days-${commandId}`}
            name="days"
            defaultValue="30"
            className="h-7 rounded-lg border border-input bg-background px-2 text-xs"
          >
            {DAY_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" name="confirm" className="mt-0.5" required />
          <span>I understand anyone with the link can see this report.</span>
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Creating..." : "Create client link"}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </form>

      {created ? (
        <div className="space-y-2 rounded-lg bg-background p-3 ring-1 ring-foreground/10">
          <CopyField value={created.url} />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            This link shows the full report to anyone who has it.
          </p>
          <p className="text-xs text-muted-foreground">
            Copy it now: it is shown only once. It works until{" "}
            {dayText(created.expiresAt)}.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setCreated(null)}
          >
            Done
          </Button>
        </div>
      ) : null}

      {shares.length > 0 ? (
        <ul className="divide-y divide-foreground/5 text-xs">
          {shares.map((share) => (
            <li
              key={share.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    STATUS_CLASS[share.status],
                  )}
                >
                  {STATUS_LABEL[share.status]}
                </span>
                <span className="text-muted-foreground">
                  {share.viewCount} {share.viewCount === 1 ? "view" : "views"} ·
                  expires {dayText(share.expiresAt)}
                </span>
              </div>
              {share.status === "ACTIVE" ? (
                <ActionForm
                  action={revokeWebsiteReportShareAction}
                  successMessage="Link revoked"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="shareId" value={share.id} />
                  <Button type="submit" variant="ghost" size="xs">
                    Revoke
                  </Button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
