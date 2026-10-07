import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-time-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { timeAgo } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type {
  GaFixChangeView,
  GaFixesView,
  GaOutsideChangeView,
} from "@/lib/website-analytics/fixes/view-types";
import {
  decideGaFixAction,
  proposeGaFixAction,
  undoGaFixAction,
} from "@/server/actions/ga-fix-actions";
import { muteMeasurementAlertAction } from "@/server/actions/measurement-health-actions";

import { TurnOffEditingForm } from "./ga-edit-access-card";
import { FIX_IT_SUCCESS_MESSAGE, FixItButton } from "./fix-it-button";

// Website sayfasındaki "Changes Agentelse made" bölümü (GA-F7,
// docs/website-fixes.md): izin durumu, öneriler, değişiklik listesi ve
// Agentelse dışında yapılan değişiklikler. Sunucuda çizilir; yalnız
// ActionForm/SubmitButton/DatePicker istemci bileşenidir. Tek sütun, mobil
// önce. Google'dan gelen sayı, e-posta ve mülk adı gösterilmez.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
const TITLE_ID = "ga-fixes-title";
const MAX_ROWS = 30;
const NOTE_PREFIX = "Agentelse: ";
const NOTE_ROOM = 60 - NOTE_PREFIX.length;
const DAY_MS = 24 * 60 * 60 * 1000;

const CHIP = "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium";

function chipClass(change: GaFixChangeView): string {
  if (change.status === "VERIFIED") return "bg-success/15 text-success";
  if (change.status === "FAILED") return "bg-destructive/10 text-destructive";
  if (change.status === "PROPOSED") return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

// Not tarihi için izin verilen aralık (doğrulayıcıyla aynı: bugünden 30 gün
// önce ile ertesi gün); 'bugün' görünümden gelir.
function dayRange(today: string): { min: string; max: string } | null {
  const at = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(at)) return null;
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { min: key(at - 30 * DAY_MS), max: key(at + DAY_MS) };
}

function AccessBanner({
  projectId,
  view,
}: {
  projectId: string;
  view: GaFixesView;
}) {
  if (view.editAccess === "granted") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Editing allowed</p>
        {view.canManage ? <TurnOffEditingForm projectId={projectId} /> : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Agentelse can only read your Google Analytics right now. To let it make
        changes you approve, allow editing.
      </p>
      {view.canManage ? (
        <a
          href={view.upgradeHref}
          className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
        >
          Allow editing
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">
          Ask a workspace owner or admin to allow editing.
        </p>
      )}
    </div>
  );
}

function NoteForm({
  projectId,
  defaultDay,
}: {
  projectId: string;
  defaultDay: string;
}) {
  const range = dayRange(defaultDay);
  return (
    <ActionForm
      action={proposeGaFixAction}
      successMessage={FIX_IT_SUCCESS_MESSAGE}
      className="space-y-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="kind" value="ANNOTATION_CREATE" />
      <input type="hidden" name="source" value="PANEL" />
      <p className="text-sm font-medium">Add a note</p>
      <p className="text-xs text-muted-foreground">
        Adds a dated note to your Google Analytics reports, after a workspace
        owner or admin approves it.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ga-note-title">Note</Label>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {NOTE_PREFIX}
            </span>
            <Input
              id="ga-note-title"
              name="title"
              required
              maxLength={NOTE_ROOM}
              placeholder="New landing page live"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ga-note-day">Date</Label>
          <DatePicker
            id="ga-note-day"
            name="day"
            defaultValue={defaultDay}
            min={range?.min}
            max={range?.max}
            aria-label="Date"
          />
        </div>
      </div>
      <SubmitButton variant="outline" size="xs">
        Add a note (needs approval)
      </SubmitButton>
    </ActionForm>
  );
}

function ChangeRow({
  projectId,
  change,
}: {
  projectId: string;
  change: GaFixChangeView;
}) {
  const alreadyThere = change.noop && change.status === "VERIFIED";
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{change.title}</p>
        <span className={cn(CHIP, chipClass(change))}>
          {change.statusLabel}
        </span>
        {alreadyThere ? (
          <span className={cn(CHIP, "bg-muted text-muted-foreground")}>
            Already there
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {timeAgo(change.resolvedAt ?? change.createdAt)}
      </p>
      {change.switchedOff ? (
        <p className="text-xs text-muted-foreground">
          This kind of change is switched off right now. It goes ahead when it
          is switched back on.
        </p>
      ) : null}
      {change.error ? (
        <p className="text-xs text-destructive">{change.error.message}</p>
      ) : null}
      {change.status === "PROPOSED" ? (
        change.canDecide ? (
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm
              action={decideGaFixAction}
              successMessage="Approved. Agentelse is applying it."
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="changeId" value={change.id} />
              <input type="hidden" name="decision" value="approve" />
              <SubmitButton variant="outline" size="xs">
                Approve
              </SubmitButton>
            </ActionForm>
            <ActionForm
              action={decideGaFixAction}
              successMessage="Rejected. Nothing was changed."
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="changeId" value={change.id} />
              <input type="hidden" name="decision" value="reject" />
              <SubmitButton variant="ghost" size="xs">
                Reject
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Waiting for a workspace owner or admin
          </p>
        )
      ) : null}
      {change.canUndo ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-foreground select-none">
            Undo
          </summary>
          <ActionForm
            action={undoGaFixAction}
            successMessage="Undone."
            className="mt-2 space-y-2"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="changeId" value={change.id} />
            <p className="text-muted-foreground">
              {change.undoWarning ??
                "This puts it back the way it was before."}
            </p>
            <SubmitButton variant="outline" size="xs">
              Undo this change
            </SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </li>
  );
}

function OutsideRow({
  projectId,
  item,
  canMute,
}: {
  projectId: string;
  item: GaOutsideChangeView;
  canMute: boolean;
}) {
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <p className="text-sm font-medium">{item.title}</p>
      {item.detail ? (
        <p className="text-xs text-muted-foreground">{item.detail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {timeAgo(item.lastSeenAt)}
        </span>
        {canMute ? (
          <ActionForm
            action={muteMeasurementAlertAction}
            successMessage="Muted for 7 days"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="alertId" value={item.alertId} />
            <SubmitButton variant="ghost" size="xs">
              Mute 7 days
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </li>
  );
}

export function GaFixesPanel({
  projectId,
  view,
}: {
  projectId: string;
  view: GaFixesView;
}) {
  const standalone = view.offers.filter((offer) => offer.checkKey === null);
  const changes = view.changes.slice(0, MAX_ROWS);

  return (
    <section
      id="changes"
      aria-labelledby={TITLE_ID}
      className={cn(CARD, "scroll-mt-20 space-y-4")}
    >
      <div className="space-y-1">
        <h2 id={TITLE_ID} className="font-heading text-base font-semibold">
          Changes Agentelse made
        </h2>
        <p className="text-xs text-muted-foreground">
          Every change needs approval from a workspace owner or admin. You can
          undo most of them.
        </p>
      </div>

      <AccessBanner projectId={projectId} view={view} />

      {standalone.length > 0 || view.alphaEnabled ? (
        <div className="space-y-3 border-t border-foreground/10 pt-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            Suggestions
          </h3>
          {standalone.map((offer) => (
            <div key={offer.id} className="space-y-1.5">
              <p className="text-sm font-medium">{offer.title}</p>
              <FixItButton
                projectId={projectId}
                offer={offer}
                canManage={view.canManage}
              />
            </div>
          ))}
          {view.alphaEnabled ? (
            <NoteForm
              projectId={projectId}
              defaultDay={view.annotationDefaultDay}
            />
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-foreground/10 pt-3">
        {changes.length > 0 ? (
          <ul className="divide-y divide-foreground/10">
            {changes.map((change) => (
              <ChangeRow key={change.id} projectId={projectId} change={change} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing here yet. When you approve a fix, it shows up here.
          </p>
        )}
      </div>

      {view.outside.length > 0 ? (
        <div className="border-t border-foreground/10 pt-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            Changed in Google Analytics outside Agentelse
          </h3>
          <ul className="divide-y divide-foreground/10">
            {view.outside.map((item) => (
              <OutsideRow
                key={item.alertId}
                projectId={projectId}
                item={item}
                canMute={view.canMuteOutside}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
