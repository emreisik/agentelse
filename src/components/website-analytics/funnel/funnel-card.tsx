import { Filter } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { gaFunnelEnabledFor } from "@/lib/website-analytics/agency/flags";
import {
  FUNNEL_MAX_STEPS,
  FUNNEL_PERIOD_OPTIONS,
  FUNNEL_PRESETS,
} from "@/lib/website-analytics/funnel/definition";
import { formatFunnelPercent } from "@/lib/website-analytics/funnel/insight";
import {
  deleteFunnelAction,
  runFunnelAction,
  saveFunnelAction,
} from "@/server/actions/funnel-actions";
import {
  GA_MAX_FUNNELS_PER_LINK,
  listFunnels,
  type FunnelView,
} from "@/server/website-analytics/funnel/store";

// Website sayfasındaki "Funnels" kartı (GA-F8, GA_FUNNEL, beta). Sunucuda
// çizilir; bayrak (ya da yerel geliştirme koruması) kapalıyken sorgusuz null
// döner. Formlar istemci kodu istemez: düz girdiler + ActionForm.

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs";

function FunnelBars({ funnel }: { funnel: FunnelView }) {
  const result = funnel.result;
  if (!result) {
    return (
      <p className="text-xs text-muted-foreground">
        {funnel.lastError
          ? "The last run didn't finish. Try again in a few minutes."
          : "Not run yet. Press Run to read this funnel."}
      </p>
    );
  }
  const first = result.steps[0]?.users ?? 0;
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {funnel.steps.map((step, index) => {
          const row = result.steps[index];
          const users = row?.users ?? 0;
          const next = result.steps[index + 1];
          const width = first > 0 ? Math.max(2, Math.round((users / first) * 100)) : 2;
          const keep =
            row?.completionRate ??
            (next && users > 0 ? Math.min(1, next.users / users) : null);
          const left =
            row?.abandonments ?? (next ? Math.max(0, users - next.users) : null);
          const isLast = index === funnel.steps.length - 1;
          return (
            <li key={`${index}-${step.name}`} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{step.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {users.toLocaleString("en-US")} users
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${width}%` }}
                />
              </div>
              {!isLast && keep !== null ? (
                <p className="text-xs text-muted-foreground">
                  {formatFunnelPercent(keep)} continue
                  {left !== null && left > 0
                    ? ` · ${left.toLocaleString("en-US")} left`
                    : ""}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {funnel.insight ? (
        <p className="text-sm">{funnel.insight.headline}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Last {funnel.periodDays} days, through {result.through}.
      </p>
    </div>
  );
}

// Oluşturma ve düzenleme aynı alanları kullanır; 6 satır çizilir, boş
// satırlar kaydedilirken atılır.
function FunnelFields({ funnel }: { funnel?: FunnelView }) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <Input
          name="name"
          defaultValue={funnel?.name ?? ""}
          maxLength={60}
          placeholder="Lead funnel"
          className="h-8 text-xs"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">Period</span>
          <select
            name="periodDays"
            defaultValue={String(funnel?.periodDays ?? 28)}
            className={SELECT_CLASS}
          >
            {FUNNEL_PERIOD_OPTIONS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1.5 text-xs">
          <input
            type="checkbox"
            name="isOpen"
            defaultChecked={funnel?.isOpen ?? false}
          />
          <span>Open funnel (people can join at any step)</span>
        </label>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          Steps (2 to {FUNNEL_MAX_STEPS}). Use an event name like purchase, or
          a page path like /thank-you.
        </p>
        {Array.from({ length: FUNNEL_MAX_STEPS }, (_, index) => {
          const step = funnel?.steps[index];
          return (
            <div
              key={index}
              className="grid grid-cols-[1fr_5.5rem_1.2fr] gap-1.5"
            >
              <Input
                name="step_name"
                defaultValue={step?.name ?? ""}
                maxLength={40}
                placeholder={`Step ${index + 1} name`}
                aria-label={`Step ${index + 1} name`}
                className="h-8 text-xs"
              />
              <select
                name="step_kind"
                defaultValue={step?.kind ?? "event"}
                aria-label={`Step ${index + 1} type`}
                className={SELECT_CLASS}
              >
                <option value="event">Event</option>
                <option value="page">Page</option>
              </select>
              <Input
                name="step_value"
                defaultValue={step?.value ?? ""}
                maxLength={200}
                placeholder="page_view or /path"
                aria-label={`Step ${index + 1} event or path`}
                className="h-8 text-xs"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CreateForm({ projectId, linkId }: { projectId: string; linkId: string }) {
  return (
    <details className="rounded-xl p-3 ring-1 ring-foreground/10">
      <summary className="cursor-pointer text-sm font-medium">
        New funnel
      </summary>
      <ActionForm
        action={saveFunnelAction}
        successMessage="Funnel saved"
        className="mt-3 space-y-3"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="linkId" value={linkId} />
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            Start from a template (or leave empty and fill in the steps below)
          </span>
          <select name="preset" defaultValue="" className={SELECT_CLASS}>
            <option value="">Custom steps</option>
            {FUNNEL_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <FunnelFields />
        <SubmitButton size="sm">Save funnel</SubmitButton>
      </ActionForm>
    </details>
  );
}

function FunnelItem({
  funnel,
  projectId,
  linkId,
  readOnly,
}: {
  funnel: FunnelView;
  projectId: string;
  linkId: string;
  readOnly: boolean;
}) {
  return (
    <section
      aria-label={funnel.name}
      className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-semibold">{funnel.name}</h3>
        {!readOnly ? (
          <ActionForm
            action={runFunnelAction}
            successMessage="Funnel updated"
            className="flex items-center gap-2"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="funnelId" value={funnel.id} />
            <SubmitButton variant="outline" size="xs">
              Run
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
      <FunnelBars funnel={funnel} />
      {!readOnly ? (
        <div className="space-y-2">
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Edit
            </summary>
            <ActionForm
              action={saveFunnelAction}
              successMessage="Funnel saved"
              className="mt-2 space-y-3"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="linkId" value={linkId} />
              <input type="hidden" name="id" value={funnel.id} />
              <FunnelFields funnel={funnel} />
              <SubmitButton size="sm">Save changes</SubmitButton>
            </ActionForm>
          </details>
          <ActionForm
            action={deleteFunnelAction}
            successMessage="Funnel deleted"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="funnelId" value={funnel.id} />
            <SubmitButton variant="ghost" size="xs">
              Delete
            </SubmitButton>
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}

// Saf görünüm: veriyi dışarıdan alır (testlerde doğrudan çizilir).
export function FunnelCardView({
  funnels,
  projectId,
  linkId,
  readOnly,
}: {
  funnels: FunnelView[];
  projectId: string;
  linkId: string;
  readOnly: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Filter className="size-4" />
        </span>
        <CardTitle className="text-base">Funnels</CardTitle>
        <Badge variant="secondary">Beta</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          See where people drop off between steps, such as a visit and a
          purchase. Numbers come from Google Analytics and each funnel can be
          refreshed a few times a day.
        </p>
        {funnels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No funnels yet.
            {readOnly ? "" : " Create one to see where people drop off."}
          </p>
        ) : (
          funnels.map((funnel) => (
            <FunnelItem
              key={funnel.id}
              funnel={funnel}
              projectId={projectId}
              linkId={linkId}
              readOnly={readOnly}
            />
          ))
        )}
        {!readOnly ? (
          funnels.length < GA_MAX_FUNNELS_PER_LINK ? (
            <CreateForm projectId={projectId} linkId={linkId} />
          ) : (
            <p className="text-xs text-muted-foreground">
              You have reached {GA_MAX_FUNNELS_PER_LINK} funnels for this
              property. Delete one to add another.
            </p>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

export async function FunnelCard({
  projectId,
  linkId,
  readOnly,
}: {
  projectId: string;
  linkId: string;
  readOnly: boolean;
}) {
  if (!gaFunnelEnabledFor(projectId)) return null;
  const funnels = await listFunnels(projectId, linkId);
  return (
    <FunnelCardView
      funnels={funnels}
      projectId={projectId}
      linkId={linkId}
      readOnly={readOnly}
    />
  );
}
