import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  checkActionNowAction,
  confirmActionLiveAction,
  dismissActionAction,
  markActionAppliedAction,
  undoActionAppliedAction,
} from "@/server/actions/seo-action-actions";
import type {
  ActionTone,
  SeoActionItem,
  SeoActionsPanel,
} from "@/server/seo/actions/panel";

// Search sayfasındaki "Actions & results" listesi (SC-F6,
// docs/search-actions.md "Arayüz"): kullanıcının sitesinde yaptığı değişiklikler
// ve Google aramasındaki sonuçları. Üç grup: Needs you (yapılacaklar ve
// sorulan sorular), In progress (doğrulanıyor / Google bekleniyor / ölçülüyor)
// ve Results. ?action= ile gelinen satır halkayla vurgulanır ve açılır.
// Yalnız props'tan çizilir (sunucu bileşeni); tek duyarlı düzen, mobil önce.
// Teklif satırlarında Google'dan gelen anahtar kelime ya da sorgu dizesi yoktur.

export const ACTIONS_TITLE_ID = "search-actions-title";

export const ACTIONS_COPY = {
  title: "Actions & results",
  subtitle: "What you changed on your site and what it did in Google Search.",
  empty: "No changes tracked yet. Use “Fix this” on an opportunity to start.",
  notConnected: "Connect Search Console to measure results in search.",
} as const;

const TONE_CLASS: Readonly<Record<ActionTone, string>> = {
  positive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  negative: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  neutral: "bg-muted text-muted-foreground",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: ActionTone;
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

function Hidden({
  projectId,
  actionId,
}: {
  projectId: string;
  actionId: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="actionId" value={actionId} />
    </>
  );
}

type FormAction = (
  formData: FormData,
) => Promise<{ ok: true; message?: string } | { ok: false; message: string }>;

function ActionButton({
  projectId,
  actionId,
  action,
  label,
  success,
  primary = false,
}: {
  projectId: string;
  actionId: string;
  action: FormAction;
  label: string;
  success: string;
  primary?: boolean;
}) {
  return (
    <ActionForm action={action} successMessage={success}>
      <Hidden projectId={projectId} actionId={actionId} />
      <SubmitButton size="xs" variant={primary ? "default" : "ghost"}>
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function Checks({ item }: { item: SeoActionItem }) {
  if (item.checks.length === 0) return null;
  return (
    <details className="text-xs" open={item.highlighted}>
      <summary className="cursor-pointer font-medium select-none">
        What we checked
      </summary>
      <ul className="mt-1.5 space-y-1 text-muted-foreground">
        {item.checks.map((check) => (
          <li key={check.label} className="flex items-start gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0 font-medium",
                check.ok
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-rose-700 dark:text-rose-400",
              )}
            >
              {check.ok ? "✓" : "✕"}
            </span>
            <span>
              <span className="sr-only">
                {check.ok ? "Passed: " : "Failed: "}
              </span>
              {check.label}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Instructions({ item }: { item: SeoActionItem }) {
  if (!item.instructions) return null;
  return (
    <details className="text-xs" open={item.highlighted}>
      <summary className="cursor-pointer font-medium select-none">
        How to do it
      </summary>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-muted-foreground">
        {item.instructions.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </details>
  );
}

function Buttons({
  projectId,
  item,
}: {
  projectId: string;
  item: SeoActionItem;
}) {
  const { can } = item;
  const any =
    can.apply ||
    can.confirmLive ||
    can.undo ||
    can.checkNow ||
    can.dismiss ||
    item.cardHref !== null;
  if (!any) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {can.apply ? (
        <ActionButton
          projectId={projectId}
          actionId={item.id}
          action={markActionAppliedAction}
          label="Mark as done"
          success="Marked as done"
          primary
        />
      ) : null}
      {can.confirmLive ? (
        <ActionButton
          projectId={projectId}
          actionId={item.id}
          action={confirmActionLiveAction}
          label="It's live"
          success="Thanks"
          primary
        />
      ) : null}
      {can.undo ? (
        <ActionButton
          projectId={projectId}
          actionId={item.id}
          action={undoActionAppliedAction}
          label="Not done yet"
          success="Moved back to your to-do list"
        />
      ) : null}
      {can.checkNow ? (
        <ActionButton
          projectId={projectId}
          actionId={item.id}
          action={checkActionNowAction}
          label="Check now"
          success="Checking your site now"
        />
      ) : null}
      {can.dismiss ? (
        <ActionButton
          projectId={projectId}
          actionId={item.id}
          action={dismissActionAction}
          label="Dismiss"
          success="Dismissed"
        />
      ) : null}
      {item.cardHref ? (
        <Link
          href={item.cardHref}
          className={buttonVariants({ variant: "outline", size: "xs" })}
        >
          Open in SEO Manager
        </Link>
      ) : null}
    </div>
  );
}

function ActionRow({
  projectId,
  item,
}: {
  projectId: string;
  item: SeoActionItem;
}) {
  return (
    <li
      id={`action-${item.id}`}
      data-kind={item.kind}
      data-status={item.status}
      data-highlighted={item.highlighted ? "true" : undefined}
      className={cn(
        "scroll-mt-20 space-y-2 rounded-xl p-4 ring-1 ring-foreground/10",
        item.highlighted && "ring-2 ring-primary",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={item.tone}>{item.statusLabel}</Chip>
        <p className="text-sm font-medium">{item.title}</p>
      </div>
      {item.headline ? (
        <div className="space-y-0.5">
          <p className="text-sm">{item.headline}</p>
          {item.detail ? (
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          ) : null}
        </div>
      ) : null}
      {item.ask ? <p className="text-sm">{item.ask}</p> : null}
      {item.note ? (
        <p className="text-xs text-muted-foreground">{item.note}</p>
      ) : null}
      {item.proposalLines.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {item.proposalLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Instructions item={item} />
      <Checks item={item} />
      <Buttons projectId={projectId} item={item} />
    </li>
  );
}

function Group({
  title,
  projectId,
  items,
}: {
  title: string;
  projectId: string;
  items: SeoActionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="space-y-3">
        {items.map((item) => (
          <ActionRow key={item.id} projectId={projectId} item={item} />
        ))}
      </ul>
    </div>
  );
}

function SummaryChips({ panel }: { panel: SeoActionsPanel }) {
  const { counts } = panel;
  const chips: { label: string; tone: ActionTone }[] = [];
  if (counts.needsYou > 0) {
    chips.push({ label: `${counts.needsYou} to do`, tone: "waiting" });
  }
  if (counts.inProgress > 0) {
    chips.push({ label: `${counts.inProgress} in progress`, tone: "neutral" });
  }
  if (counts.worked > 0) {
    chips.push({ label: `${counts.worked} worked`, tone: "positive" });
  }
  if (counts.didnt > 0) {
    chips.push({ label: `${counts.didnt} didn't work`, tone: "negative" });
  }
  if (counts.inconclusive > 0) {
    chips.push({
      label: `${counts.inconclusive} no clear result`,
      tone: "neutral",
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <Chip key={chip.label} tone={chip.tone}>
          {chip.label}
        </Chip>
      ))}
    </div>
  );
}

export function ActionsListView({
  panel,
}: {
  panel: SeoActionsPanel;
}): React.JSX.Element {
  const empty =
    panel.needsYou.length === 0 &&
    panel.inProgress.length === 0 &&
    panel.results.length === 0;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2
          id={ACTIONS_TITLE_ID}
          className="font-heading text-base font-semibold"
        >
          {ACTIONS_COPY.title}
        </h2>
        <p className="text-xs text-muted-foreground">{ACTIONS_COPY.subtitle}</p>
        <SummaryChips panel={panel} />
        {panel.searchConnected ? null : (
          <p className="text-xs text-muted-foreground">
            {ACTIONS_COPY.notConnected}
          </p>
        )}
      </div>
      {empty ? (
        <EmptyState title={ACTIONS_COPY.empty} className="py-8" />
      ) : (
        <>
          <Group
            title="Needs you"
            projectId={panel.projectId}
            items={panel.needsYou}
          />
          <Group
            title="In progress"
            projectId={panel.projectId}
            items={panel.inProgress}
          />
          <Group
            title="Results"
            projectId={panel.projectId}
            items={panel.results}
          />
        </>
      )}
    </div>
  );
}
