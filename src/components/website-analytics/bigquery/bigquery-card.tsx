import { Database } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/website-analytics/bigquery/budget";
import { EXPORT_CHECK_NOTE } from "@/lib/website-analytics/bigquery/compare";
import {
  gaBigQueryMessage,
  isGaBigQueryErrorCode,
} from "@/lib/website-analytics/bigquery/errors";
import {
  refreshBigQuerySourceAction,
  removeBigQuerySourceAction,
  saveBigQuerySourceAction,
} from "@/server/actions/bigquery-actions";
import {
  loadBigQueryCard,
  type BigQueryCardView,
} from "@/server/website-analytics/bigquery/read";

// "BigQuery export check" kartı (GA-F8, docs/website-agency.md): GA4'ün BigQuery dışa
// aktarımını Agentelse'e açan müşteri, dışa aktarımın GA'nın verdiği sayılarla
// uyuştuğunu görür. Sunucuda çizilir; yalnız ActionForm/SubmitButton istemcidir.
// Servis hesabı e-postası yalnız kurulum ve hata durumlarında gösterilir.

const TITLE_ID = "ga-bigquery-title";
const CHIP = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

type CardProps = {
  projectId: string;
  linkId: string;
  canManage: boolean;
  readOnly: boolean;
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Database className="size-4" />
        </span>
        <CardTitle id={TITLE_ID} className="text-base">
          BigQuery export check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function HiddenIds({ projectId, linkId }: { projectId: string; linkId: string }) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="linkId" value={linkId} />
    </>
  );
}

function ManageButtons({ projectId, linkId }: { projectId: string; linkId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <ActionForm
        action={refreshBigQuerySourceAction}
        successMessage="Refresh requested"
      >
        <HiddenIds projectId={projectId} linkId={linkId} />
        <SubmitButton variant="outline" size="sm">
          Refresh
        </SubmitButton>
      </ActionForm>
      <ActionForm
        action={removeBigQuerySourceAction}
        successMessage="BigQuery export removed"
      >
        <HiddenIds projectId={projectId} linkId={linkId} />
        <SubmitButton variant="outline" size="sm">
          Remove
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

function SetupSteps({ view }: { view: BigQueryCardView }) {
  const who = view.serviceAccountEmail ?? "the Agentelse service account";
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Already exporting Google Analytics 4 to BigQuery? Let Agentelse check
        that the export and the numbers Google Analytics reports agree.
        Agentelse only reads daily totals and stores nothing else.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          In Google Analytics, link this property to BigQuery with the daily
          export turned on.
        </li>
        <li>
          In Google Cloud, give <span className="font-mono">{who}</span> the
          BigQuery Data Viewer role on the dataset and BigQuery Job User on the
          same project. Queries run in your project.
        </li>
      </ol>
    </div>
  );
}

function SetupForm({
  view,
  projectId,
  linkId,
}: {
  view: BigQueryCardView;
  projectId: string;
  linkId: string;
}) {
  return (
    <ActionForm
      action={saveBigQuerySourceAction}
      successMessage="BigQuery export connected"
      className="space-y-3"
    >
      <HiddenIds projectId={projectId} linkId={linkId} />
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Dataset</p>
        <p className="font-mono text-sm" data-testid="bq-dataset">
          {view.suggestedDataset}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`bq-project-${linkId}`}>
          Google Cloud project that holds the export
        </Label>
        <Input
          id={`bq-project-${linkId}`}
          name="gcpProjectId"
          placeholder="my-company-123456"
          required
          autoComplete="off"
          maxLength={30}
        />
      </div>
      <SubmitButton size="sm">Connect and check</SubmitButton>
    </ActionForm>
  );
}

function Check({ view }: { view: BigQueryCardView }) {
  const compare = view.compare;
  if (!compare || compare.level === "unknown") {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough days to compare yet. The check needs at least 7 days of
        both.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-sm">
        {compare.level === "close"
          ? "Your export and the Google Analytics numbers are within 10% for the last 28 days."
          : "Your export and the Google Analytics numbers differ by more than 10% for the last 28 days."}
      </p>
      <p className="text-xs text-muted-foreground">
        Sessions differ by {compare.sessionsDiffPct}% and users by{" "}
        {compare.usersDiffPct}% over {compare.days} days. {EXPORT_CHECK_NOTE}
      </p>
    </div>
  );
}

function TopList({
  title,
  rows,
  note,
}: {
  title: string;
  rows: { label: string; value: number }[];
  note?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {title}
        {note ? <span className="font-normal"> · {note}</span> : null}
      </p>
      <ul className="space-y-0.5 text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex justify-between gap-3">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {row.value.toLocaleString("en-US")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Saf görünüm: veri yüklemeden çizer (testler bunu doğrudan çağırır).
export function BigQueryCardBody({
  view,
  projectId,
  linkId,
  canManage,
  readOnly,
}: CardProps & { view: BigQueryCardView }) {
  const manage = canManage && !readOnly;
  if (view.state === "off") return null;

  if (view.state === "not_configured") {
    if (!manage) return null;
    return (
      <Frame>
        <p className="text-sm text-muted-foreground">
          {gaBigQueryMessage("not_configured", null)}
        </p>
      </Frame>
    );
  }

  if (view.state === "not_set_up") {
    if (!manage) return null;
    return (
      <Frame>
        <SetupSteps view={view} />
        <SetupForm view={view} projectId={projectId} linkId={linkId} />
      </Frame>
    );
  }

  // pending | ok | error: salt okunur görünümde yönetim düğmeleri yoktur.
  const budgetUsed = `${formatBytes(view.usageBytes)} of ${formatBytes(view.budgetBytes)}`;
  const errorMessage =
    view.state === "error" && isGaBigQueryErrorCode(view.errorCode)
      ? gaBigQueryMessage(view.errorCode, view.serviceAccountEmail)
      : view.state === "error"
        ? gaBigQueryMessage("unavailable", view.serviceAccountEmail)
        : null;
  const budgetNote =
    view.state === "ok" && view.errorCode === "budget"
      ? gaBigQueryMessage("budget", null)
      : null;

  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-2">
        {view.state === "ok" ? (
          <span className={`${CHIP} bg-success/15 text-success`}>Connected</span>
        ) : view.state === "pending" ? (
          <span className={`${CHIP} bg-muted text-muted-foreground`}>
            Waiting for the first read
          </span>
        ) : (
          <span className={`${CHIP} bg-destructive/10 text-destructive`}>
            Needs attention
          </span>
        )}
        {view.lastDay ? (
          <span className="text-xs text-muted-foreground">
            Last export day: {view.lastDay}
          </span>
        ) : null}
      </div>

      {view.config ? (
        <p className="font-mono text-xs text-muted-foreground">
          {view.config.gcpProjectId} · {view.config.datasetId}
        </p>
      ) : null}

      {errorMessage ? <p className="text-sm">{errorMessage}</p> : null}
      {budgetNote ? (
        <p className="text-xs text-muted-foreground">{budgetNote}</p>
      ) : null}
      {view.state === "pending" ? (
        <p className="text-sm text-muted-foreground">
          Agentelse reads the export once a day. The first read happens within
          the next hours.
        </p>
      ) : null}

      {view.state === "ok" ? (
        <>
          <Check view={view} />
          <TopList
            title="Top events"
            rows={view.topEvents.map((row) => ({
              label: row.name,
              value: row.count,
            }))}
          />
          <TopList
            title="Top pages"
            note="Top 50 per day"
            rows={view.topPages.map((row) => ({
              label: row.page,
              value: row.views,
            }))}
          />
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Read this month: {budgetUsed}
      </p>

      {manage ? <ManageButtons projectId={projectId} linkId={linkId} /> : null}
    </Frame>
  );
}

export async function BigQueryCard(props: CardProps) {
  const view = await loadBigQueryCard(props.projectId, props.linkId);
  if (view.state === "off") return null;
  return <BigQueryCardBody {...props} view={view} />;
}
