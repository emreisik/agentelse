"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_SHARE_DAYS,
  REPORT_SHARE_DAYS,
} from "@/lib/report-share/types";
import { createReportShareAction } from "@/server/actions/report-share-actions";

import { HINT_CLASS, SELECT_CLASS, formatDay } from "./form-helpers";

// "Create share link" denetimleri (SC-F9). Adres yalnız oluşturulduğu an
// görünür (sunucuda yalnız özeti saklanır); onay kutusu işaretlenmeden düğme
// çalışmaz.

// Adres panosuna kopyalanır; bağlı olduğu başka bir eylem modülü yoktur.
function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => toast.error("Couldn't copy. Select the text instead."));
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export const SHARE_CONFIRM_TEXT =
  "I understand anyone with the link sees this report";
export const SHARE_WARNING_TEXT =
  "This link shows the full report to anyone who has it.";

export function NewShareUrlPanel({
  url,
  expiresAt,
}: {
  url: string;
  expiresAt: string;
}) {
  return (
    <div
      role="status"
      data-state="new-share"
      className="space-y-2 rounded-xl bg-muted p-3"
    >
      <p className="text-sm font-medium">Share link created</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-background px-2 py-1 text-xs">
          {url}
        </code>
        <CopyButton value={url} label="Copy link" />
      </div>
      <p className={HINT_CLASS}>
        Expires {formatDay(expiresAt)}. We can&apos;t show this link again, so
        copy it now.
      </p>
      <p className="text-xs text-destructive">{SHARE_WARNING_TEXT}</p>
    </div>
  );
}

export function ShareCreateControls({
  projectId,
  reportId,
}: {
  projectId: string;
  reportId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);
  const [days, setDays] = useState(String(DEFAULT_SHARE_DAYS));
  const [created, setCreated] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    const data = new FormData();
    data.set("projectId", projectId);
    data.set("reportId", reportId);
    data.set("days", days);
    data.set("confirm", "on");
    startTransition(async () => {
      try {
        const result = await createReportShareAction(data);
        if (result.ok) {
          setCreated({ url: result.url, expiresAt: result.expiresAt });
          setConfirmed(false);
          router.refresh();
        } else {
          toast.error(result.message || "Couldn't create the link");
        }
      } catch {
        toast.error("Couldn't create the link");
      }
    });
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Link works for</span>
            <select
              value={days}
              onChange={(event) => setDays(event.target.value)}
              className={SELECT_CLASS}
            >
              {REPORT_SHARE_DAYS.map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!confirmed || pending}>
            {pending ? "Creating..." : "Create share link"}
          </Button>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            required
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>{SHARE_CONFIRM_TEXT}</span>
        </label>
      </form>
      {created ? (
        <NewShareUrlPanel url={created.url} expiresAt={created.expiresAt} />
      ) : null}
    </div>
  );
}
