"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, Download, Loader2, PenLine } from "lucide-react";

import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScheduleField } from "@/components/calendar/schedule-field";
import {
  formatPickerValue,
  splitDateTime,
  todayKeyIn,
} from "@/lib/date-picker";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { reviseCreativeAction } from "@/server/actions/creative-actions";
import {
  getCreativePreviewAction,
  type CreativePreview,
} from "@/server/actions/creative-actions";
import { assignCreativeDateAction } from "@/server/actions/creative-calendar-actions";
import { CREATIVE_STATUS } from "@/lib/labels";
import type { CreativeStatus } from "@prisma/client";
import { assetUrl } from "@/lib/asset-url";

// The spec's "Output Preview Dialog" — the single, shared inline preview
// for a creative, opened from the Outputs grid, the Calendar list, and
// (in a later slice) the in-chat CreativeReadyCard's "View details". A
// client-side fetch (getCreativePreviewAction) rather than server props:
// this dialog is mounted once per panel and only needs real data once the
// user actually opens one, and the panels that trigger it (OutputsPanel,
// CalendarPanel) only carry the thin WorkspaceOutputItem projection, not
// the caption/copy/version/approvalId fields this view needs.
export function OutputPreviewDialog({
  creativeId,
  onOpenChange,
  onChanged,
}: {
  creativeId: string | null;
  onOpenChange: (open: boolean) => void;
  // Onay/ret, değişiklik isteği ya da takvime ekleme sonrası: istemcide kendi
  // verisini tutan paneller (Outputs) tazelensin.
  onChanged?: () => void;
}) {
  return (
    <Dialog open={creativeId !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="w-full max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-[17px] p-0 ring-0 sm:max-w-[820px] sm:grid-cols-[45%_55%]"
        style={{ background: "var(--ws-surface)", maxHeight: "90dvh" }}
      >
        {creativeId ? (
          <PreviewBody
            key={creativeId}
            creativeId={creativeId}
            onChanged={onChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  creativeId,
  onChanged,
}: {
  creativeId: string;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<CreativePreview | null | undefined>(
    undefined,
  );
  const [localStatus, setLocalStatus] = useState<CreativeStatus | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showRevise, setShowRevise] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [isRevising, startRevising] = useTransition();
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCreativePreviewAction(creativeId).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [creativeId]);

  if (data === undefined) {
    return (
      <div className="flex min-h-[360px] items-center justify-center p-8 sm:col-span-2">
        <Loader2
          className="size-5 animate-spin"
          style={{ color: "var(--ws-text-3)" }}
        />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 p-8 sm:col-span-2">
        <DialogTitle style={{ color: "var(--ws-text)" }}>
          This output couldn&apos;t be found
        </DialogTitle>
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          It may have been removed, or you may not have access to it.
        </p>
      </div>
    );
  }

  const status = localStatus ?? data.status;
  const src = data.assetId ? assetUrl(data.assetId, "large") : undefined;
  const format = getCreativePlatformFormat(data.platform, data.contentFormat);
  const title = data.title ?? "Output";
  const canDecide = status === "IN_REVIEW" && Boolean(data.approvalId);

  const decide = (to: "APPROVED" | "REJECTED") => {
    if (!data.approvalId) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("approvalId", data.approvalId!);
      const action =
        to === "APPROVED" ? approveApprovalAction : rejectApprovalAction;
      const result = await action(formData);
      if (result.ok) {
        setLocalStatus(to);
        toast.success(to === "APPROVED" ? "Approved" : "Rejected");
        onChanged?.();
      } else {
        toast.error(result.message);
      }
    });
  };

  const revise = () => {
    if (!instruction.trim()) return;
    startRevising(async () => {
      const result = await reviseCreativeAction(creativeId, instruction);
      if (result.ok) {
        setInstruction("");
        setShowRevise(false);
        toast.success(
          "Revising — the new version will appear in the chat shortly",
        );
        router.refresh();
        onChanged?.();
      } else {
        toast.error(result.message);
      }
    });
  };

  const copyCaption = () => {
    const text = data.copy || data.caption;
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Couldn't copy"));
  };

  return (
    <>
      <div
        className="flex items-center justify-center overflow-hidden p-6"
        style={{ background: "var(--ws-surface-2)" }}
      >
        <div className="w-full max-w-[320px]">
          <div
            className="mb-2 text-[10px] font-medium tracking-wide uppercase"
            style={{ color: "var(--ws-text-3)" }}
          >
            {src ? "Preview" : "Image not ready yet"}
          </div>
          <div
            className="overflow-hidden rounded-lg"
            style={{
              background: "var(--ws-hover)",
              aspectRatio: "4 / 5",
            }}
          >
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image can't optimize it
              <img src={src} alt={title} className="size-full object-cover" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex max-h-[90dvh] flex-col overflow-y-auto p-6">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {data.platform
              ? `${format.label} · ${format.contentFormatLabel}`
              : "Image"}
          </span>
          {data.versionNumber ? (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                background: "var(--ws-surface-2)",
                color: "var(--ws-text-2)",
              }}
            >
              v{data.versionNumber}
            </span>
          ) : null}
        </div>

        <p
          className="mt-2 text-[22px] leading-tight font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </p>

        <div
          className="mt-3 flex items-center gap-1.5 text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          <span
            className="size-1.5 rounded-full"
            style={{
              background:
                status === "APPROVED" || status === "PUBLISHED"
                  ? "var(--ws-approved)"
                  : status === "IN_REVIEW"
                    ? "var(--ws-pending)"
                    : status === "REJECTED"
                      ? "var(--destructive)"
                      : "var(--ws-text-3)",
            }}
          />
          {CREATIVE_STATUS[status].label}
        </div>

        {data.copy || data.caption ? (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[11px] font-medium"
                style={{ color: "var(--ws-text-3)" }}
              >
                Caption
              </span>
              <button
                type="button"
                onClick={copyCaption}
                className="flex items-center gap-1 text-[11px] font-medium transition-colors hover:opacity-70"
                style={{ color: "var(--ws-text-2)" }}
              >
                <Copy className="size-3" />
                Copy
              </button>
            </div>
            <p
              className="mt-1 text-sm leading-snug whitespace-pre-wrap"
              style={{ color: "var(--ws-text-body)" }}
            >
              {data.copy || data.caption}
            </p>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {canDecide ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={isPending}
                className="rounded-[10px]"
                style={{
                  background: "var(--ws-accent)",
                  color: "var(--ws-on-accent)",
                }}
                onClick={() => decide("APPROVED")}
              >
                <Check className="size-3.5" />
                Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-[10px]"
                style={{ color: "var(--ws-text-3)" }}
                disabled={isPending}
                onClick={() => decide("REJECTED")}
              >
                Reject
              </Button>
            </>
          ) : null}
          {status !== "PUBLISHED" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-[10px]"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
              disabled={isRevising}
              onClick={() => setShowRevise((v) => !v)}
            >
              <PenLine className="size-3.5" />
              Request a change
            </Button>
          ) : null}
          {data.assetId ? (
            <a
              href={`/api/assets/${data.assetId}`}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-3 text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text)",
              }}
            >
              <Download className="size-3.5" />
              Download
            </a>
          ) : null}
        </div>

        {showRevise ? (
          <div className="mt-2 flex gap-1.5">
            <Input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="What should change? e.g. make the headline punchier…"
              disabled={isRevising}
              className="h-8 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  revise();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0 rounded-[10px]"
              style={{
                background: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }}
              disabled={isRevising || !instruction.trim()}
              onClick={revise}
            >
              {isRevising ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                "Send"
              )}
            </Button>
          </div>
        ) : null}

        {status === "APPROVED" ? (
          <div
            className="mt-4 border-t pt-4"
            style={{ borderColor: "var(--ws-border)" }}
          >
            {data.scheduledFor && !showSchedule ? (
              <button
                type="button"
                onClick={() => setShowSchedule(true)}
                className="text-xs font-medium transition-colors hover:opacity-70"
                style={{ color: "var(--ws-text-2)" }}
              >
                Scheduled for{" "}
                {formatPickerValue(
                  splitDateTime(zonedValue(data.scheduledFor, data.timezone)) ??
                    {},
                  Number(todayKeyIn(data.timezone).slice(0, 4)),
                )}{" "}
                · change
              </button>
            ) : (
              <ScheduleForm
                creativeId={creativeId}
                projectId={data.projectId}
                timezone={data.timezone}
                scheduledFor={data.scheduledFor}
                onSaved={() => {
                  router.refresh();
                  onChanged?.();
                }}
              />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

// scheduledFor bir UTC anıdır; seçici ve etiket projenin saat dilimindeki duvar
// saatini ("YYYY-MM-DDTHH:mm") gösterir. (Eskiden ISO dizgesinin ilk 16 karakteri
// alınıyordu: UTC saati yerel saat gibi gösterilir ve her kayıtta kayardı.)
function zonedValue(scheduledFor: string | null, timezone: string): string {
  return scheduledFor
    ? utcToZonedDateTimeLocal(new Date(scheduledFor), timezone)
    : "";
}

function ScheduleForm({
  creativeId,
  projectId,
  timezone,
  scheduledFor,
  onSaved,
}: {
  creativeId: string;
  projectId: string;
  timezone: string;
  scheduledFor: string | null;
  onSaved: () => void;
}) {
  const [isSaving, startSaving] = useTransition();
  const defaultValue = zonedValue(scheduledFor, timezone);

  return (
    <form
      className="flex items-end gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startSaving(async () => {
          const result = await assignCreativeDateAction(formData);
          if (result.ok) {
            toast.success("Added to calendar");
            onSaved();
          } else {
            toast.error(result.message);
          }
        });
      }}
    >
      <input type="hidden" name="creativeId" value={creativeId} />
      <label className="block flex-1 space-y-1">
        <span
          className="text-[11px] font-medium"
          style={{ color: "var(--ws-text-3)" }}
        >
          Day &amp; time
        </span>
        <ScheduleField
          name="date"
          // Kayıt sonrası sunucu yeni zamanı verince alan baştan kurulur.
          key={defaultValue}
          defaultValue={defaultValue}
          timezone={timezone}
          projectId={projectId}
          creativeId={creativeId}
        />
      </label>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="h-8 rounded-[10px]"
        disabled={isSaving}
      >
        {isSaving ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          "Add to calendar"
        )}
      </Button>
    </form>
  );
}
