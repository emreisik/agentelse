"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import {
  MAKE_LIVE_LABEL,
  PUBLISH_DRAFT_LABEL,
  SEO_CHANGE_ERROR_MESSAGES,
} from "@/lib/seo/apply/copy";
import type {
  PublishStatusView,
  SeoChangeView,
} from "@/lib/seo/apply/view-types";
import { cn } from "@/lib/utils";
import {
  decideSeoChangeAction,
  proposeMakeLiveAction,
  proposePublishArticleAction,
  undoSeoChangeAction,
} from "@/server/actions/seo-apply-actions";

import { StatusChip, statusToneOf } from "./changes-list";

// Makale kartındaki ve takvim yuvasındaki "Publish to WordPress (draft)" bloğu
// (SC-F8, docs/website-apply.md "Makale yayını"). Ebeveynler bunu YALNIZ sunucu
// applyReady/features.apply hesapladığında çizer: bayrak kapalıyken ölü düğme ve
// istemci isteği yoktur. Durumu hafif yoklama ucundan okur (cache: 'no-store'),
// APPROVED/APPLYING/APPLIED iken 4 sn'de bir yoklar (en çok 3 dakika) ve
// kaldırıldığında aralığı temizler. Her durum görünür: bağlı değil, onay
// bekliyor, uygulanıyor, taslak hazır (bağlantıyla), yayına alma bekliyor,
// yayında, hata (sabit metin; yazısı inmiş hatada Undo), geri alındı.

const POLL_MS = 4_000;
const POLL_MAX_MS = 3 * 60_000;

const BUSY: readonly SeoChangeView["status"][] = [
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "UNDOING",
];

function isBusy(change: SeoChangeView | null): boolean {
  return change !== null && BUSY.includes(change.status);
}

export const PUBLISH_COPY = {
  draftNote:
    "Nothing is created on WordPress until an owner or admin approves. The draft is not visible to visitors.",
  calendarNote:
    "Scheduling this article on the calendar does not schedule the WordPress post.",
  waitingMember: "Waiting for an owner or admin",
  approveDraft: "Approve and create the draft",
  approveLive: "Approve and make it live",
  draftReady: "Draft created on WordPress",
  live: "Live on your site",
  liveWaiting: "Making it live: waiting for approval",
  liveApplying: "Making it live",
  undone: "Undone. The draft is in the WordPress Trash.",
  liveUndone: "It is a draft again.",
  connectHint: "Connect WordPress to send this article as a draft.",
  connect: "Connect WordPress",
  checkConnection: "Check the connection",
  loadFailed: "The WordPress status could not be loaded.",
} as const;

function Hidden({
  projectId,
  creativeId,
  changeId,
}: {
  projectId: string;
  creativeId?: string;
  changeId?: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      {creativeId ? (
        <input type="hidden" name="creativeId" value={creativeId} />
      ) : null}
      {changeId ? (
        <input type="hidden" name="changeId" value={changeId} />
      ) : null}
    </>
  );
}

type Reload = () => void;

function DecideButtons({
  projectId,
  change,
  approveLabel,
  onDone,
}: {
  projectId: string;
  change: SeoChangeView;
  approveLabel: string;
  onDone: Reload;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm
        action={decideSeoChangeAction}
        successMessage="Approved. Agentelse is applying it now."
        onSuccess={onDone}
      >
        <Hidden projectId={projectId} changeId={change.id} />
        <input type="hidden" name="decision" value="approve" />
        <SubmitButton size="xs">{approveLabel}</SubmitButton>
      </ActionForm>
      <ActionForm
        action={decideSeoChangeAction}
        successMessage="Rejected. Nothing was changed."
        onSuccess={onDone}
      >
        <Hidden projectId={projectId} changeId={change.id} />
        <input type="hidden" name="decision" value="reject" />
        <SubmitButton size="xs" variant="ghost">
          Reject
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

function UndoButton({
  projectId,
  change,
  onDone,
}: {
  projectId: string;
  change: SeoChangeView;
  onDone: Reload;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm
        action={undoSeoChangeAction}
        successMessage="Undone."
        onSuccess={onDone}
      >
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
  );
}

function ProposeDraftButton({
  projectId,
  creativeId,
  label,
  onDone,
}: {
  projectId: string;
  creativeId: string;
  label: string;
  onDone: Reload;
}) {
  return (
    <ActionForm
      action={proposePublishArticleAction}
      successMessage="Sent for approval."
      onSuccess={onDone}
    >
      <Hidden projectId={projectId} creativeId={creativeId} />
      <SubmitButton size="xs" variant="outline">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function Working({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

function ErrorText({ change }: { change: SeoChangeView }) {
  return (
    <p className="text-xs text-rose-700 dark:text-rose-400">
      {change.error?.message ?? SEO_CHANGE_ERROR_MESSAGES.unknown}
    </p>
  );
}

function Notes() {
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>{PUBLISH_COPY.draftNote}</p>
      <p>{PUBLISH_COPY.calendarNote}</p>
    </div>
  );
}

// Canlı yayın önerisi formu (ilk öneri, geri alma sonrası ve başarısız deneme).
function MakeLiveForm({
  projectId,
  changeId,
  onDone,
}: {
  projectId: string;
  changeId: string;
  onDone: Reload;
}) {
  return (
    <div className="space-y-1.5">
      <ActionForm
        action={proposeMakeLiveAction}
        successMessage="Sent for approval."
        onSuccess={onDone}
      >
        <Hidden projectId={projectId} changeId={changeId} />
        <SubmitButton size="xs" variant="outline">
          {MAKE_LIVE_LABEL}
        </SubmitButton>
      </ActionForm>
      <p className="text-xs text-muted-foreground">
        Makes the article visible to everyone.
      </p>
    </div>
  );
}

// Canlı yayın (PUBLISH_LIVE) kısmı: taslak hazırken gösterilir.
function LiveSection({
  projectId,
  status,
  isManager,
  onDone,
}: {
  projectId: string;
  status: PublishStatusView;
  isManager: boolean;
  onDone: Reload;
}) {
  const { change, liveChange } = status;
  if (!change) return null;
  const liveOpen =
    liveChange !== null &&
    (liveChange.status === "PROPOSED" || isBusy(liveChange));

  if (liveChange && liveChange.status === "PROPOSED") {
    return (
      <div className="space-y-1.5">
        <StatusChip tone="waiting">{PUBLISH_COPY.liveWaiting}</StatusChip>
        {liveChange.canDecide ? (
          <DecideButtons
            projectId={projectId}
            change={liveChange}
            approveLabel={PUBLISH_COPY.approveLive}
            onDone={onDone}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {PUBLISH_COPY.waitingMember}
          </p>
        )}
      </div>
    );
  }
  if (liveChange && isBusy(liveChange)) {
    return <Working label={PUBLISH_COPY.liveApplying} />;
  }
  if (liveChange && liveChange.status === "FAILED") {
    // Hiçbir şey yazılmadıysa (ör. taslak değişti) yeniden öneri açık kalır;
    // yazıldıysa yalnız geri alma sunulur.
    return (
      <div className="space-y-1.5">
        <ErrorText change={liveChange} />
        {liveChange.canUndo ? (
          isManager ? (
            <UndoButton
              projectId={projectId}
              change={liveChange}
              onDone={onDone}
            />
          ) : null
        ) : change.canMakeLive ? (
          <MakeLiveForm
            projectId={projectId}
            changeId={change.id}
            onDone={onDone}
          />
        ) : null}
      </div>
    );
  }
  if (liveChange && liveChange.status === "VERIFIED" && !liveChange.noop) {
    const href =
      liveChange.link && /^https:\/\//i.test(liveChange.link)
        ? liveChange.link
        : null;
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="positive">{PUBLISH_COPY.live}</StatusChip>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              Open the page
            </a>
          ) : null}
        </div>
        {liveChange.canUndo && isManager ? (
          <UndoButton
            projectId={projectId}
            change={liveChange}
            onDone={onDone}
          />
        ) : null}
      </div>
    );
  }

  // Yayında değil ya da geri alındı: yeniden yayına alma önerilebilir.
  if (change.canMakeLive && !liveOpen) {
    return (
      <div className="space-y-1.5">
        {liveChange?.status === "UNDONE" ? (
          <p className="text-xs text-muted-foreground">
            {PUBLISH_COPY.liveUndone}
          </p>
        ) : null}
        <MakeLiveForm
          projectId={projectId}
          changeId={change.id}
          onDone={onDone}
        />
      </div>
    );
  }
  return null;
}

// Durum gövdesi: kanca içermez, her durum doğrudan sınanabilir.
export function PublishStatusBody({
  projectId,
  creativeId,
  status,
  isManager,
  compact = false,
  onDone = () => undefined,
}: {
  projectId: string;
  creativeId: string;
  status: PublishStatusView;
  isManager: boolean;
  compact?: boolean;
  onDone?: Reload;
}): React.JSX.Element {
  const { change, liveChange } = status;
  const liveActive =
    liveChange !== null &&
    liveChange.status !== "UNDONE" &&
    liveChange.status !== "REJECTED" &&
    liveChange.status !== "EXPIRED" &&
    // Hiçbir şey yazmadan başarısız olan yayın makale geri almasını engellemez.
    !(liveChange.status === "FAILED" && !liveChange.canUndo);

  let body: React.ReactNode;
  if (!status.connected) {
    body = (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {PUBLISH_COPY.connectHint}
        </p>
        <Link
          href={status.connectHref}
          className={buttonVariants({ variant: "outline", size: "xs" })}
        >
          {PUBLISH_COPY.connect}
        </Link>
      </div>
    );
  } else if (!status.healthy) {
    body = (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {status.blockedReason ?? SEO_CHANGE_ERROR_MESSAGES.site_unhealthy}
        </p>
        <Link
          href={status.connectHref}
          className={buttonVariants({ variant: "outline", size: "xs" })}
        >
          {PUBLISH_COPY.checkConnection}
        </Link>
      </div>
    );
  } else if (!change) {
    body = status.canPropose ? (
      <div className="space-y-1.5">
        <ProposeDraftButton
          projectId={projectId}
          creativeId={creativeId}
          label={PUBLISH_DRAFT_LABEL}
          onDone={onDone}
        />
        <Notes />
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">{status.blockedReason}</p>
    );
  } else if (change.status === "PROPOSED") {
    body = (
      <div className="space-y-1.5">
        <StatusChip tone="waiting">{change.statusLabel}</StatusChip>
        {change.canDecide ? (
          <DecideButtons
            projectId={projectId}
            change={change}
            approveLabel={PUBLISH_COPY.approveDraft}
            onDone={onDone}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {PUBLISH_COPY.waitingMember}
          </p>
        )}
      </div>
    );
  } else if (isBusy(change)) {
    body = <Working label={change.statusLabel} />;
  } else if (change.status === "VERIFIED") {
    const href =
      change.link && /^https:\/\//i.test(change.link) ? change.link : null;
    body = (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="positive">{PUBLISH_COPY.draftReady}</StatusChip>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              Open the draft
            </a>
          ) : null}
        </div>
        <LiveSection
          projectId={projectId}
          status={status}
          isManager={isManager}
          onDone={onDone}
        />
        {/* Yayındayken makale geri alması zaten reddedilir; yalnız taslakta sunulur. */}
        {change.canUndo && isManager && !liveActive ? (
          <UndoButton projectId={projectId} change={change} onDone={onDone} />
        ) : null}
      </div>
    );
  } else if (change.status === "FAILED") {
    body = (
      <div className="space-y-1.5">
        <StatusChip tone={statusToneOf(change.status)}>
          {change.statusLabel}
        </StatusChip>
        <ErrorText change={change} />
        <div className="flex flex-wrap items-center gap-2">
          {change.canUndo && isManager ? (
            <UndoButton projectId={projectId} change={change} onDone={onDone} />
          ) : null}
          {status.canPropose ? (
            <ProposeDraftButton
              projectId={projectId}
              creativeId={creativeId}
              label={PUBLISH_DRAFT_LABEL}
              onDone={onDone}
            />
          ) : null}
        </div>
      </div>
    );
  } else {
    // UNDONE, REJECTED, EXPIRED: yeniden önerilebilir.
    body = (
      <div className="space-y-1.5">
        <StatusChip tone={statusToneOf(change.status)}>
          {change.status === "UNDONE"
            ? PUBLISH_COPY.undone
            : change.statusLabel}
        </StatusChip>
        {status.canPropose ? (
          <div className="space-y-1.5">
            <ProposeDraftButton
              projectId={projectId}
              creativeId={creativeId}
              label={PUBLISH_DRAFT_LABEL}
              onDone={onDone}
            />
            <Notes />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-publish-state={change?.status ?? "NONE"}
      className={cn("space-y-1.5", compact ? "text-xs" : "text-sm")}
    >
      {body}
    </div>
  );
}

// Durum ucundan okur; sonuç null ise okuma başarısızdır. Durum ayarlamaz.
async function fetchStatus(
  projectId: string,
  creativeId: string,
): Promise<PublishStatusView | null> {
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/seo/apply/status?creativeId=${encodeURIComponent(creativeId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    return (await response.json()) as PublishStatusView;
  } catch {
    return null;
  }
}

export function PublishToWordPress({
  projectId,
  creativeId,
  isManager,
  compact = false,
}: {
  projectId: string;
  creativeId: string;
  isManager: boolean;
  compact?: boolean;
}): React.JSX.Element | null {
  const [status, setStatus] = useState<PublishStatusView | null>(null);
  const [failed, setFailed] = useState(false);
  const statusRef = useRef<PublishStatusView | null>(null);
  const startedAt = useRef<number>(0);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    void fetchStatus(projectId, creativeId).then((next) => {
      if (!alive.current) return;
      if (next) {
        statusRef.current = next;
        setStatus(next);
        setFailed(false);
      } else {
        setFailed(true);
      }
    });
  }, [projectId, creativeId]);

  // Bir eylemden sonra yeniden okunur ve yoklama süresi sıfırlanır.
  const reload = useCallback(() => {
    startedAt.current = Date.now();
    refresh();
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    startedAt.current = Date.now();
    refresh();
    const timer = setInterval(() => {
      const current = statusRef.current;
      const busy =
        isBusy(current?.change ?? null) || isBusy(current?.liveChange ?? null);
      if (busy && Date.now() - startedAt.current < POLL_MAX_MS) refresh();
    }, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  if (failed && !status) {
    return (
      <p className="text-xs text-muted-foreground">{PUBLISH_COPY.loadFailed}</p>
    );
  }
  if (!status) return null;
  return (
    <PublishStatusBody
      projectId={projectId}
      creativeId={creativeId}
      status={status}
      isManager={isManager || status.isManager}
      compact={compact}
      onDone={reload}
    />
  );
}
