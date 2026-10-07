"use client";

import { useId, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-time-picker";
import { PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { daysInMonth } from "@/lib/seo/content-plan/schedule";
import {
  moveSlotAction,
  replaceSlotAction,
  skipSlotAction,
} from "@/server/actions/seo-content-plan-actions";

// Bir slotun "More" menüsü (SC-F7): Move (yalnız ui/date-time-picker.tsx),
// Skip (üç ay dışlama notuyla) ve Replace. Açılır liste yerine satır içi
// açılan bir panel: formlar menü kapanırken yarıda kalmaz, klavyeyle
// düğmeden panele doğal sırayla gidilir.

function Hidden({
  projectId,
  slotId,
}: {
  projectId: string;
  slotId: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="slotId" value={slotId} />
    </>
  );
}

export function SlotMenu({
  projectId,
  slotId,
  month,
  date,
  canMove,
  canSkip,
  canReplace,
}: {
  projectId: string;
  slotId: string;
  // "2026-10": taşıma yalnız bu ayın içinde
  month: string;
  date: string | null;
  canMove: boolean;
  canSkip: boolean;
  canReplace: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!canMove && !canSkip && !canReplace) return null;
  const close = () => setOpen(false);
  return (
    <div className="relative">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="More actions"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal />
      </Button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Article actions"
          className="mt-2 w-full min-w-64 space-y-3 rounded-lg p-3 ring-1 ring-foreground/10 sm:absolute sm:right-0 sm:z-10 sm:w-72 sm:bg-popover sm:shadow-md"
        >
          {canMove ? (
            <ActionForm
              action={moveSlotAction}
              successMessage="Moved"
              onSuccess={close}
              className="space-y-1.5"
            >
              <Hidden projectId={projectId} slotId={slotId} />
              <p className="text-xs font-medium">{PLAN_COPY.move}</p>
              <div className="flex items-center gap-2">
                <DatePicker
                  name="date"
                  defaultValue={date ?? ""}
                  min={`${month}-01`}
                  max={`${month}-${String(daysInMonth(month)).padStart(2, "0")}`}
                  disablePast
                  aria-label="New day for this article"
                />
                <SubmitButton size="xs" variant="outline">
                  {PLAN_COPY.move}
                </SubmitButton>
              </div>
            </ActionForm>
          ) : null}
          {canReplace ? (
            <ActionForm
              action={replaceSlotAction}
              successMessage="Replaced"
              onSuccess={close}
              className="flex items-center justify-between gap-2"
            >
              <Hidden projectId={projectId} slotId={slotId} />
              <p className="text-xs text-muted-foreground">
                Swap it for another topic.
              </p>
              <SubmitButton size="xs" variant="outline">
                {PLAN_COPY.replace}
              </SubmitButton>
            </ActionForm>
          ) : null}
          {canSkip ? (
            <ActionForm
              action={skipSlotAction}
              successMessage="Skipped"
              onSuccess={close}
              className="space-y-1.5"
            >
              <Hidden projectId={projectId} slotId={slotId} />
              <p className="text-xs text-muted-foreground">
                {PLAN_COPY.skipNote}
              </p>
              <SubmitButton size="xs" variant="ghost">
                {PLAN_COPY.skip}
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
