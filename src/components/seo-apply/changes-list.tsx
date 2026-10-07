import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { MAKE_LIVE_LABEL } from "@/lib/seo/apply/copy";
import type { SeoChangeStatus } from "@/lib/seo/apply/types";
import type { SeoApplyView, SeoChangeView } from "@/lib/seo/apply/view-types";
import { cn } from "@/lib/utils";
import {
  decideSeoChangeAction,
  proposeMakeLiveAction,
  saveApplySettingsAction,
  undoSeoChangeAction,
} from "@/server/actions/seo-apply-actions";

// Search sayfasındaki "Website changes" listesi (SC-F8, docs/website-apply.md
// "Arayüz"): WordPress sitesine önerilen, onay bekleyen, uygulanan ve geri
// alınan değişiklikler. Yalnız props'tan çizilir (kanca yok); tek duyarlı düzen,
// mobil önce. Metinler sabit İngilizcedir, hata metni saklı sabit metindir.
// Düğmeler: onay/ret (yalnız canDecide), Undo (yalnız yönetici ve canUndo),
// Make it live (canMakeLive).

export const CHANGES_TITLE_ID = "website-changes-title";

export const CHANGES_COPY = {
  title: "Website changes",
  subtitle:
    "Changes Agentelse makes on your WordPress site. Every change needs an owner or admin to approve it first, and you can undo it.",
  empty:
    "No website changes yet. Send an article to WordPress from the SEO Manager, or use “Apply with approval” on an opportunity.",
  notConnected: "WordPress is not connected.",
  connect: "Connect WordPress",
  noop: "It was already like this on the page. Nothing was changed.",
  draftNote: "Saved as a draft. It is not visible to visitors.",
} as const;

type Tone = "positive" | "negative" | "neutral" | "waiting";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  positive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  negative: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  neutral: "bg-muted text-muted-foreground",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

const STATUS_TONE: Readonly<Record<SeoChangeStatus, Tone>> = {
  PROPOSED: "waiting",
  APPROVED: "waiting",
  APPLYING: "waiting",
  APPLIED: "waiting",
  VERIFIED: "positive",
  FAILED: "negative",
  UNDOING: "waiting",
  UNDONE: "neutral",
  REJECTED: "neutral",
  EXPIRED: "neutral",
};

export function statusToneOf(status: SeoChangeStatus): Tone {
  return STATUS_TONE[status];
}

export function StatusChip({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

const INDEX_NOW_LABEL: Readonly<
  Record<NonNullable<SeoChangeView["indexNow"]>, string>
> = {
  PENDING: "IndexNow: queued",
  SENT: "IndexNow: sent",
  SKIPPED: "IndexNow: skipped",
  FAILED: "IndexNow: not sent",
};

// ISO metninden UTC gün (sunucu ve istemcide aynı çıktı).
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function Hidden({
  projectId,
  changeId,
}: {
  projectId: string;
  changeId: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="changeId" value={changeId} />
    </>
  );
}

function ChangeButtons({
  projectId,
  change,
  canManage,
}: {
  projectId: string;
  change: SeoChangeView;
  canManage: boolean;
}) {
  const showUndo = change.canUndo && canManage;
  if (!change.canDecide && !showUndo && !change.canMakeLive) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {change.canDecide ? (
        <>
          <ActionForm
            action={decideSeoChangeAction}
            successMessage="Approved. Agentelse is applying it now."
          >
            <Hidden projectId={projectId} changeId={change.id} />
            <input type="hidden" name="decision" value="approve" />
            <SubmitButton size="xs">Approve</SubmitButton>
          </ActionForm>
          <ActionForm
            action={decideSeoChangeAction}
            successMessage="Rejected. Nothing was changed."
          >
            <Hidden projectId={projectId} changeId={change.id} />
            <input type="hidden" name="decision" value="reject" />
            <SubmitButton size="xs" variant="ghost">
              Reject
            </SubmitButton>
          </ActionForm>
        </>
      ) : null}
      {change.canMakeLive ? (
        <ActionForm
          action={proposeMakeLiveAction}
          successMessage="Sent for approval."
        >
          <Hidden projectId={projectId} changeId={change.id} />
          <SubmitButton size="xs" variant="outline">
            {MAKE_LIVE_LABEL}
          </SubmitButton>
        </ActionForm>
      ) : null}
      {showUndo ? (
        <div className="flex flex-wrap items-center gap-2">
          <ActionForm action={undoSeoChangeAction} successMessage="Undone.">
            <Hidden projectId={projectId} changeId={change.id} />
            <SubmitButton size="xs" variant="ghost">
              Undo
            </SubmitButton>
          </ActionForm>
          {change.undoWarning ? (
            <span className="text-xs text-muted-foreground">
              {change.undoWarning}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChangeRow({
  projectId,
  change,
  canManage,
}: {
  projectId: string;
  change: SeoChangeView;
  canManage: boolean;
}) {
  const link = change.link;
  const safeLink = link && /^https:\/\//i.test(link) ? link : null;
  return (
    <li
      id={`change-${change.id}`}
      data-kind={change.kind}
      data-status={change.status}
      className="scroll-mt-20 space-y-2 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone={statusToneOf(change.status)}>
          {change.statusLabel}
        </StatusChip>
        <p className="text-sm font-medium">{change.title}</p>
        <span className="text-xs text-muted-foreground">
          {dayOf(change.createdAt)}
        </span>
      </div>
      {change.noop ? (
        <p className="text-xs text-muted-foreground">{CHANGES_COPY.noop}</p>
      ) : null}
      {change.preview.length > 0 ? (
        <dl className="space-y-0.5 text-xs">
          {change.preview.map((row, index) => (
            <div key={`${row.label}-${index}`} className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">
                {row.label}
              </dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {change.error ? (
        <p className="text-xs text-rose-700 dark:text-rose-400">
          {change.error.message}
        </p>
      ) : null}
      {change.kind === "PUBLISH_ARTICLE" &&
      change.draft &&
      change.status === "VERIFIED" ? (
        <p className="text-xs text-muted-foreground">
          {CHANGES_COPY.draftNote}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {safeLink ? (
          <a
            href={safeLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {change.draft ? "Open the draft" : "Open the page"}
          </a>
        ) : null}
        {change.indexNow ? (
          <span className="text-muted-foreground">
            {INDEX_NOW_LABEL[change.indexNow]}
          </span>
        ) : null}
      </div>
      <ChangeButtons
        projectId={projectId}
        change={change}
        canManage={canManage}
      />
    </li>
  );
}

function Connection({
  projectId,
  view,
}: {
  projectId: string;
  view: SeoApplyView;
}) {
  const { connection } = view;
  const href = `/projects/${projectId}/integrations?integration=wordpress`;
  if (!connection.connected) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{CHANGES_COPY.notConnected}</span>
        <Link
          href={href}
          className={buttonVariants({ variant: "outline", size: "xs" })}
        >
          {CHANGES_COPY.connect}
        </Link>
      </div>
    );
  }
  const healthy = connection.health === "OK" || connection.health === "LIMITED";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <StatusChip tone={healthy ? "positive" : "negative"}>
        {connection.healthLabel}
      </StatusChip>
      <span className="text-muted-foreground">{connection.host}</span>
      <Link
        href={href}
        className="text-primary underline-offset-4 hover:underline"
      >
        WordPress settings
      </Link>
    </div>
  );
}

function DailyLimit({
  projectId,
  view,
}: {
  projectId: string;
  view: SeoApplyView;
}) {
  const usage = `${view.usedToday} of ${view.dailyLimit} changes used in the last 24 hours`;
  if (!view.canManage) {
    return <p className="text-xs text-muted-foreground">{usage}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-xs text-muted-foreground">{usage}</p>
      <ActionForm
        action={saveApplySettingsAction}
        successMessage="Saved."
        className="flex items-center gap-1.5"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <label htmlFor="seo-apply-daily-limit" className="text-xs">
          Daily limit
        </label>
        <input
          id="seo-apply-daily-limit"
          name="dailyLimit"
          type="number"
          min={1}
          max={25}
          defaultValue={view.dailyLimit}
          className="h-6 w-14 rounded-md border border-border bg-background px-1.5 text-xs"
        />
        <SubmitButton size="xs" variant="outline">
          Save
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

export function ChangesListView({
  view,
  projectId,
}: {
  view: SeoApplyView;
  projectId: string;
}): React.JSX.Element {
  const waiting = view.changes.filter(
    (change) => change.status === "PROPOSED",
  ).length;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <h2
          id={CHANGES_TITLE_ID}
          className="font-heading text-base font-semibold"
        >
          {CHANGES_COPY.title}
        </h2>
        <p className="text-xs text-muted-foreground">{CHANGES_COPY.subtitle}</p>
        <Connection projectId={projectId} view={view} />
        {view.connection.connected ? (
          <DailyLimit projectId={projectId} view={view} />
        ) : null}
        {waiting > 0 ? (
          <StatusChip tone="waiting">{`${waiting} waiting for approval`}</StatusChip>
        ) : null}
      </div>
      {view.changes.length === 0 ? (
        <EmptyState title={CHANGES_COPY.empty} className="py-8" />
      ) : (
        <ul className="space-y-3">
          {view.changes.map((change) => (
            <ChangeRow
              key={change.id}
              projectId={projectId}
              change={change}
              canManage={view.canManage}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
