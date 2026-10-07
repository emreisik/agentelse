import { ExternalLink } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { FixItButton } from "@/components/website-analytics/fix-it-button";
import { MeasurementDot } from "@/components/website-analytics/measurement-score";
import { timeAgo } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  describeCheck,
  suspectDaysText,
} from "@/lib/website-analytics/health/copy";
import type { GaFixOffer } from "@/lib/website-analytics/fixes/view-types";
import { gaGuide } from "@/lib/website-analytics/health/guides";
import { GA_CHECKS } from "@/lib/website-analytics/health/registry";
import type {
  GaCheckKey,
  GaCheckSeverity,
} from "@/lib/website-analytics/health/types";
import type {
  MeasurementCheckView,
  MeasurementHealthView,
  MeasurementTone,
} from "@/lib/website-analytics/health/view-types";
import {
  muteMeasurementAlertAction,
  recheckMeasurementHealthAction,
} from "@/server/actions/measurement-health-actions";

// "Website" sayfasındaki "Measurement health" paneli (GA-F3,
// docs/google-analytics-plan.md §6.1): kontrol listesi, İngilizce düzeltme
// rehberleri, Check again / I fixed it / Mute 7 days. Sunucuda çizilir;
// yalnız ActionForm/SubmitButton istemci bileşeni. Tek sütun, mobil önce.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
const TITLE_ID = "measurement-health-title";

const SEVERITY_RANK: Record<GaCheckSeverity, number> = {
  CRITICAL: 0,
  WARN: 1,
  INFO: 2,
};

const SEVERITY_TONE: Record<GaCheckSeverity, MeasurementTone> = {
  CRITICAL: "error",
  WARN: "warning",
  INFO: "unknown",
};

const REGISTRY_ORDER = new Map<GaCheckKey, number>(
  GA_CHECKS.map((def, index) => [def.key, index]),
);

function registryIndex(key: GaCheckKey): number {
  return REGISTRY_ORDER.get(key) ?? REGISTRY_ORDER.size;
}

// Düzeltilecekler: WARN/FAIL; CRITICAL > WARN > INFO, sonra kayıt sırası.
function needsAttention(
  checks: MeasurementCheckView[],
): MeasurementCheckView[] {
  return checks
    .filter((check) => check.status === "WARN" || check.status === "FAIL")
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
        registryIndex(a.key) - registryIndex(b.key),
    );
}

// Yeniden kontrol kısıtı bileşen dışında okunur (çizim saf kalsın).
function recheckLocked(availableAt: string | null): boolean {
  if (!availableAt) return false;
  const at = new Date(availableAt).getTime();
  return Number.isFinite(at) && at > Date.now();
}

const LOCKED_TITLE = "Available in a few minutes";

// GA-F8: ek mülkte yazan düğme yok; not yalnız "Check again" düğmesinin yerinde.
const READ_ONLY_NOTE =
  "Changes to this property are made on the main property view.";

function RecheckForm({
  projectId,
  checkKey,
  locked,
  label,
  successMessage,
  variant,
}: {
  projectId: string;
  checkKey: GaCheckKey | null;
  locked: boolean;
  label: string;
  successMessage: string;
  variant: "outline" | "ghost";
}) {
  return (
    <ActionForm
      action={recheckMeasurementHealthAction}
      successMessage={successMessage}
    >
      <input type="hidden" name="projectId" value={projectId} />
      {checkKey ? (
        <input type="hidden" name="checkKey" value={checkKey} />
      ) : null}
      <SubmitButton
        variant={variant}
        size="xs"
        disabled={locked}
        title={locked ? LOCKED_TITLE : undefined}
      >
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function Guide({ guideId }: { guideId: string }) {
  const guide = gaGuide(guideId);
  if (!guide) return null;
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer font-medium text-foreground select-none">
        How to fix
      </summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p className="font-medium text-foreground">{guide.title}</p>
        {guide.where ? <p>Where: {guide.where}</p> : null}
        <ol className="list-decimal space-y-1 pl-4">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {guide.links.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {guide.links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  {link.label}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

function IssueRow({
  projectId,
  check,
  timeZone,
  locked,
  offers = [],
  canManageFixes = true,
  readOnly = false,
}: {
  projectId: string;
  check: MeasurementCheckView;
  timeZone: string;
  locked: boolean;
  // GA-F7: bu kontrole bağlı "Fix it for me" teklifleri
  offers?: GaFixOffer[];
  canManageFixes?: boolean;
  readOnly?: boolean;
}) {
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <MeasurementDot tone={SEVERITY_TONE[check.severity] ?? "unknown"} />
        <p className="text-sm font-medium">{check.title}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="mr-1.5 inline-flex rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Code {check.code}
        </span>
        {describeCheck(check, { timeZone })}
      </p>
      <Guide guideId={check.guideId} />
      {readOnly
        ? null
        : offers.map((offer) => (
            <FixItButton
              key={offer.id}
              projectId={projectId}
              offer={offer}
              canManage={canManageFixes}
            />
          ))}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <RecheckForm
            projectId={projectId}
            checkKey={check.key}
            locked={locked}
            label="I fixed it"
            successMessage="Thanks — we checked again. We'll confirm with the next day's data."
            variant="outline"
          />
          {check.alertId ? (
            <ActionForm
              action={muteMeasurementAlertAction}
              successMessage="Muted for 7 days"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="alertId" value={check.alertId} />
              <SubmitButton variant="ghost" size="xs">
                Mute 7 days
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      )}
    </li>
  );
}

function CheckList({
  checks,
  timeZone,
}: {
  checks: MeasurementCheckView[];
  timeZone: string;
}) {
  return (
    <ul className="mt-2 space-y-1.5">
      {checks.map((check) => (
        <li key={check.key} className="text-xs">
          <span className="font-medium text-foreground">{check.title}</span>
          <span className="text-muted-foreground">
            {" "}
            — {describeCheck(check, { timeZone })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MeasurementHealthPanel({
  projectId,
  health,
  fixOffers = [],
  canManageFixes = true,
  readOnly = false,
}: {
  projectId: string;
  health: MeasurementHealthView;
  fixOffers?: GaFixOffer[];
  canManageFixes?: boolean;
  // GA-F8: ek mülk; yazan form/düğme çizilmez.
  readOnly?: boolean;
}) {
  const { summary, timeZone } = health;
  const issues = needsAttention(health.checks);
  const unknown = health.checks.filter((check) => check.status === "UNKNOWN");
  const passed = health.checks.filter((check) => check.status === "PASS");
  const locked = recheckLocked(health.recheckAvailableAt);
  const suspect = suspectDaysText(health.suspectDays);
  const telegramNote = issues.some(
    (check) =>
      (check.key === "MH1" || check.key === "MH1_RT") &&
      check.severity === "CRITICAL",
  );
  const scoreLabel = summary.score === null ? "Checking…" : summary.label;

  return (
    <section
      id="measurement-health"
      aria-labelledby={TITLE_ID}
      className={cn(CARD, "scroll-mt-20 space-y-4")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 id={TITLE_ID} className="font-heading text-base font-semibold">
              Measurement health
            </h2>
            <MeasurementDot tone={summary.tone} />
            <span className="text-sm text-muted-foreground">{scoreLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {summary.evaluatedAt
              ? `Checked ${timeAgo(summary.evaluatedAt)}`
              : "Not checked yet"}
          </p>
        </div>
        {readOnly ? (
          <p className="max-w-xs text-xs text-muted-foreground">
            {READ_ONLY_NOTE}
          </p>
        ) : (
          <RecheckForm
            projectId={projectId}
            checkKey={null}
            locked={locked}
            label="Check again"
            successMessage="Checked again. Data checks update when new Google Analytics data arrives."
            variant="outline"
          />
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Needs attention
        </h3>
        {issues.length > 0 ? (
          <ul className="divide-y divide-foreground/10">
            {issues.map((check) => (
              <IssueRow
                key={check.key}
                projectId={projectId}
                check={check}
                timeZone={timeZone}
                locked={locked}
                offers={fixOffers.filter((o) => o.checkKey === check.key)}
                canManageFixes={canManageFixes}
                readOnly={readOnly}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm">No tracking problems found.</p>
        )}
        {telegramNote ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Alerts also go to your project&rsquo;s Telegram when it is
            connected.
          </p>
        ) : null}
      </div>

      <div className="space-y-2 border-t border-foreground/10 pt-3">
        {unknown.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground select-none">
              Couldn&rsquo;t check ({unknown.length})
            </summary>
            <CheckList checks={unknown} timeZone={timeZone} />
          </details>
        ) : null}
        {passed.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground select-none">
              {passed.length} {passed.length === 1 ? "check" : "checks"} passed
            </summary>
            <CheckList checks={passed} timeZone={timeZone} />
          </details>
        ) : null}
      </div>

      {suspect || health.siteCheckedAt ? (
        <div className="space-y-1 text-[11px] text-muted-foreground">
          {suspect ? <p>{suspect}</p> : null}
          {health.siteCheckedAt ? (
            <p>
              Site checked {timeAgo(health.siteCheckedAt)} as
              AgentelseSiteCheck.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
