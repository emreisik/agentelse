import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Megaphone, Plug, Plus } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  DATE_PRESETS,
  DEFAULT_DATE_PRESET,
  isDatePreset,
  MetaAdsQuery,
  type DatePreset,
} from "@/server/integrations/meta-ads-query";
import type {
  MetaCredentialMetadata,
  MetaInsightsRow,
} from "@/server/integrations/meta-client";
import { createMetaAdAction } from "@/server/actions/meta-ads-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { CampaignWizard } from "@/components/ads/campaign-wizard";
import { AdSetAdWizard } from "@/components/ads/adset-ad-wizard";
import { cn } from "@/lib/utils";

// Live, read-only drill-down over Meta's Campaign -> AdSet -> Ad hierarchy —
// no local Campaign/AdSet/Ad table (see MetaAdsQuery). The same page renders
// all three levels, switching on `?campaignId=` / `?adSetId=` search
// params — same RSC-first pattern as integrations/page.tsx, no client state.
export default async function AdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const { userId } = await requireUser();
  try {
    await requireProjectAccess(userId, projectId);
  } catch {
    notFound();
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  const connection = await MetaAdsQuery.resolveConnection(projectId);
  const base = `/projects/${projectId}/ads`;

  if (connection.status !== "READY") {
    return (
      <AppShell projectId={projectId}>
        <div className="space-y-6 p-6 pb-16">
          <Header projectName={project.name} />
          <EmptyState
            icon={Plug}
            title={
              connection.status === "NOT_CONNECTED"
                ? "Meta not connected"
                : "No ad account selected"
            }
            hint={
              connection.status === "NOT_CONNECTED"
                ? "Connect a Meta account to see and create campaigns."
                : "Select an ad account on the Integrations page first."
            }
            className="py-16"
          >
            <Link
              href={`/projects/${projectId}/integrations?integration=meta`}
              className={cn(buttonVariants({ size: "sm" }))}
            >
              Go to Integrations
            </Link>
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  const metadata = (credential?.metadata ?? {}) as MetaCredentialMetadata;
  const currency =
    metadata.adAccounts?.find((a) => a.adAccountId === connection.adAccountId)
      ?.currency ?? "USD";

  const campaignId =
    typeof sp.campaignId === "string" ? sp.campaignId : undefined;
  const adSetId = typeof sp.adSetId === "string" ? sp.adSetId : undefined;
  const datePreset: DatePreset =
    typeof sp.range === "string" && isDatePreset(sp.range)
      ? sp.range
      : DEFAULT_DATE_PRESET;

  const campaigns = await MetaAdsQuery.campaigns(connection, datePreset);
  const activeCampaign = campaignId
    ? campaigns.find((c) => c.campaignId === campaignId)
    : undefined;

  const adSets =
    campaignId && activeCampaign
      ? await MetaAdsQuery.adSets(connection, campaignId, datePreset)
      : [];
  const activeAdSet =
    adSetId && adSets.length
      ? adSets.find((a) => a.adSetId === adSetId)
      : undefined;

  const ads =
    adSetId && activeAdSet
      ? await MetaAdsQuery.ads(connection, adSetId, datePreset)
      : [];

  const create = typeof sp.create === "string" ? sp.create : undefined;
  const brief = typeof sp.brief === "string" ? sp.brief : undefined;
  const currentUrl = new URLSearchParams();
  if (campaignId) currentUrl.set("campaignId", campaignId);
  if (adSetId) currentUrl.set("adSetId", adSetId);
  if (datePreset !== DEFAULT_DATE_PRESET) currentUrl.set("range", datePreset);
  const closeHref = currentUrl.toString()
    ? `${base}?${currentUrl.toString()}`
    : base;
  const createParams = new URLSearchParams(currentUrl);
  createParams.set("create", "campaign");
  const createCampaignHref = `${base}?${createParams.toString()}`;
  const createAdSetParams = new URLSearchParams(currentUrl);
  createAdSetParams.set("create", "adset");
  const createAdSetHref = `${base}?${createAdSetParams.toString()}`;
  const createAdParams = new URLSearchParams(currentUrl);
  createAdParams.set("create", "ad");
  const createAdHref = `${base}?${createAdParams.toString()}`;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Header projectName={project.name} />
          <div className="flex items-center gap-2">
            <DateRangeSelector
              currentUrl={currentUrl}
              base={base}
              value={datePreset}
            />
            {!campaignId ? (
              <Link
                href={createCampaignHref}
                className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
              >
                <Plus className="size-4" />
                New Campaign
              </Link>
            ) : activeCampaign && !adSetId ? (
              <Link
                href={createAdSetHref}
                className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
              >
                <Plus className="size-4" />
                New Ad Set
              </Link>
            ) : activeAdSet ? (
              <Link
                href={createAdHref}
                className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
              >
                <Plus className="size-4" />
                New Ad
              </Link>
            ) : null}
          </div>
        </div>

        <Breadcrumb base={base} campaign={activeCampaign} adSet={activeAdSet} />

        {!campaignId ? (
          <CampaignsTable
            base={base}
            campaigns={campaigns}
            currency={currency}
          />
        ) : !activeCampaign ? (
          <EmptyState
            icon={Megaphone}
            title="Campaign not found"
            hint="It may have been deleted or renamed on Meta's side."
            className="py-16"
          />
        ) : !adSetId ? (
          <AdSetsTable
            base={base}
            campaignId={campaignId}
            adSets={adSets}
            currency={currency}
          />
        ) : !activeAdSet ? (
          <EmptyState
            icon={Megaphone}
            title="Ad set not found"
            hint="It may have been deleted or renamed on Meta's side."
            className="py-16"
          />
        ) : (
          <AdsTable ads={ads} currency={currency} />
        )}

        {create === "campaign" ? (
          <CreateCampaignDialog
            projectId={projectId}
            closeHref={closeHref}
            prefillName={brief}
          />
        ) : null}
        {create === "adset" && campaignId ? (
          <CreateAdSetDialog
            projectId={projectId}
            campaignId={campaignId}
            closeHref={closeHref}
          />
        ) : null}
        {create === "ad" && adSetId ? (
          <CreateAdDialog
            projectId={projectId}
            adSetId={adSetId}
            closeHref={closeHref}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Creation dialogs — same EntityDialog + ActionForm pattern as
// integrations/page.tsx. Each form maps directly to one
// TaskPlanner.planForCapability call (see meta-ads-actions.ts); nothing is
// created on Meta until the resulting Approval is decided.

function CreateCampaignDialog({
  projectId,
  closeHref,
  prefillName,
}: {
  projectId: string;
  closeHref: string;
  prefillName?: string;
}) {
  return (
    <EntityDialog
      closeHref={closeHref}
      title="New Campaign"
      size="md"
      bodyClassName="overflow-y-auto p-6"
    >
      <CampaignWizard
        projectId={projectId}
        closeHref={closeHref}
        prefillName={prefillName}
      />
    </EntityDialog>
  );
}

function CreateAdSetDialog({
  projectId,
  campaignId,
  closeHref,
}: {
  projectId: string;
  campaignId: string;
  closeHref: string;
}) {
  return (
    <EntityDialog
      closeHref={closeHref}
      title="New Ad Set + Ad"
      description="Targeting, budget and one ad's creative — both require approval."
      size="md"
      bodyClassName="overflow-y-auto p-6"
    >
      <AdSetAdWizard
        projectId={projectId}
        campaignId={campaignId}
        closeHref={closeHref}
      />
    </EntityDialog>
  );
}

const CALL_TO_ACTIONS = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD",
  "CONTACT_US",
  "GET_OFFER",
];

function CreateAdDialog({
  projectId,
  adSetId,
  closeHref,
}: {
  projectId: string;
  adSetId: string;
  closeHref: string;
}) {
  return (
    <EntityDialog
      closeHref={closeHref}
      title="New Ad"
      description="Image + copy for this ad set — requires approval before it goes live."
      size="md"
      bodyClassName="space-y-3 overflow-y-auto p-4"
    >
      <ActionForm
        action={createMetaAdAction}
        successMessage="Ad submitted for approval"
        className="space-y-3"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="adSetId" value={adSetId} />
        <Field label="Name">
          <Input name="name" required placeholder="Ad — variant A" />
        </Field>
        <Field label="Image (JPEG/PNG/WebP, max 8MB)">
          <input
            name="image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
            className="w-full text-xs"
          />
        </Field>
        <Field label="Primary text">
          <Input
            name="message"
            required
            placeholder="Discover the new collection"
          />
        </Field>
        <Field label="Destination link">
          <Input
            name="link"
            type="url"
            required
            placeholder="https://example.com/sale"
          />
        </Field>
        <Field label="Call to action">
          <select
            name="callToActionType"
            required
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
          >
            {CALL_TO_ACTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end pt-1">
          <SubmitButton size="sm">Create Ad</SubmitButton>
        </div>
      </ActionForm>
    </EntityDialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Header({ projectName }: { projectName: string }) {
  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Ads Manager
      </h1>
      <p className="text-sm text-muted-foreground">
        {projectName} — Meta campaigns, ad sets and ads (live from Meta)
      </p>
    </div>
  );
}

function Breadcrumb({
  base,
  campaign,
  adSet,
}: {
  base: string;
  campaign?: { campaignId: string; name: string };
  adSet?: { adSetId: string; name: string };
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <Link href={base} className="hover:text-foreground">
        Campaigns
      </Link>
      {campaign ? (
        <>
          <ChevronRight className="size-3.5 shrink-0" />
          <Link
            href={`${base}?campaignId=${campaign.campaignId}`}
            className={cn(
              adSet ? "hover:text-foreground" : "font-medium text-foreground",
            )}
          >
            {campaign.name}
          </Link>
        </>
      ) : null}
      {adSet ? (
        <>
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">{adSet.name}</span>
        </>
      ) : null}
    </div>
  );
}

// Budgets (daily_budget/lifetime_budget) come back from Meta in minor units
// (cents) — insights values (spend, cost_per_result) do NOT, they're
// already in the account's major currency unit. Two separate formatters so
// that distinction can't get silently mixed up at a call site.
function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function formatCurrency(amount: number | undefined, currency: string): string {
  if (amount === undefined) return "—";
  return `${amount.toFixed(2)} ${currency}`;
}

function formatCount(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

function statusTone(status: string): "positive" | "waiting" | "neutral" {
  if (status === "ACTIVE") return "positive";
  if (status === "PAUSED") return "waiting";
  return "neutral";
}

// A row of plain links that swap `?range=` — no client state, same
// RSC-first pattern as the rest of this page (see FILTERS in
// integrations/page.tsx). currentUrl already carries campaignId/adSetId so
// switching the range doesn't reset the drill-down level.
function DateRangeSelector({
  currentUrl,
  base,
  value,
}: {
  currentUrl: URLSearchParams;
  base: string;
  value: DatePreset;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-muted p-0.5">
      {DATE_PRESETS.map((preset) => {
        const params = new URLSearchParams(currentUrl);
        if (preset.value === DEFAULT_DATE_PRESET) {
          params.delete("range");
        } else {
          params.set("range", preset.value);
        }
        const href = params.toString() ? `${base}?${params.toString()}` : base;
        const active = preset.value === value;
        return (
          <Link
            key={preset.value}
            href={href}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {preset.label}
          </Link>
        );
      })}
    </div>
  );
}

function Table({
  columns,
  children,
  empty,
}: {
  columns: string[];
  children: React.ReactNode;
  empty?: boolean;
}) {
  if (empty) {
    return (
      <EmptyState
        icon={Megaphone}
        title="Nothing here yet"
        hint="Create one from the chat to get started."
        className="py-16"
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="px-3.5 py-2 text-left font-medium whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

// Right-aligned, whitespace-nowrap — every reporting number column
// (results, spend, impressions, reach, ...) shares this cell so figures
// line up in a column instead of ragging left like the text columns.
function NumCell({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3.5 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
      {children}
    </td>
  );
}

const REPORTING_COLUMNS = [
  "Results",
  "Cost / Result",
  "Amount Spent",
  "Impressions",
  "Reach",
  "CTR",
  "CPM",
];

function ReportingCells({
  insights,
  currency,
}: {
  insights: MetaInsightsRow | undefined;
  currency: string;
}) {
  return (
    <>
      <NumCell>
        {insights?.resultCount !== undefined ? (
          <span className="flex flex-col items-end">
            <span className="font-medium text-foreground">
              {formatCount(insights.resultCount)}
            </span>
            <span className="text-[10px] text-muted-foreground/70">
              {insights.resultLabel}
            </span>
          </span>
        ) : (
          "—"
        )}
      </NumCell>
      <NumCell>{formatCurrency(insights?.costPerResult, currency)}</NumCell>
      <NumCell>{formatCurrency(insights?.spend, currency)}</NumCell>
      <NumCell>{formatCount(insights?.impressions)}</NumCell>
      <NumCell>{formatCount(insights?.reach)}</NumCell>
      <NumCell>{formatPercent(insights?.ctr)}</NumCell>
      <NumCell>{formatCurrency(insights?.cpm, currency)}</NumCell>
    </>
  );
}

function CampaignsTable({
  base,
  campaigns,
  currency,
}: {
  base: string;
  campaigns: Awaited<ReturnType<typeof MetaAdsQuery.campaigns>>;
  currency: string;
}) {
  return (
    <Table
      columns={[
        "Name",
        "Objective",
        "Status",
        "Daily Budget",
        ...REPORTING_COLUMNS,
      ]}
      empty={campaigns.length === 0}
    >
      {campaigns.map((c) => (
        <tr key={c.campaignId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <Link
              href={`${base}?campaignId=${c.campaignId}`}
              className="font-medium text-foreground hover:underline"
            >
              {c.name}
            </Link>
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
            {c.objective}
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <StatusBadge
              meta={{ label: c.effectiveStatus, tone: statusTone(c.status) }}
            />
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
            {formatMoney(c.dailyBudgetCents, currency)}
          </td>
          <ReportingCells insights={c.insights} currency={currency} />
        </tr>
      ))}
    </Table>
  );
}

function AdSetsTable({
  base,
  campaignId,
  adSets,
  currency,
}: {
  base: string;
  campaignId: string;
  adSets: Awaited<ReturnType<typeof MetaAdsQuery.adSets>>;
  currency: string;
}) {
  return (
    <Table
      columns={[
        "Name",
        "Optimization Goal",
        "Status",
        "Daily Budget",
        ...REPORTING_COLUMNS,
      ]}
      empty={adSets.length === 0}
    >
      {adSets.map((a) => (
        <tr key={a.adSetId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <Link
              href={`${base}?campaignId=${campaignId}&adSetId=${a.adSetId}`}
              className="font-medium text-foreground hover:underline"
            >
              {a.name}
            </Link>
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
            {a.optimizationGoal ?? "—"}
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <StatusBadge
              meta={{ label: a.effectiveStatus, tone: statusTone(a.status) }}
            />
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
            {formatMoney(a.dailyBudgetCents, currency)}
          </td>
          <ReportingCells insights={a.insights} currency={currency} />
        </tr>
      ))}
    </Table>
  );
}

function AdsTable({
  ads,
  currency,
}: {
  ads: Awaited<ReturnType<typeof MetaAdsQuery.ads>>;
  currency: string;
}) {
  return (
    <Table
      columns={["Name", "Status", ...REPORTING_COLUMNS]}
      empty={ads.length === 0}
    >
      {ads.map((a) => (
        <tr key={a.adId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5 font-medium whitespace-nowrap text-foreground">
            {a.name}
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <StatusBadge
              meta={{ label: a.effectiveStatus, tone: statusTone(a.status) }}
            />
          </td>
          <ReportingCells insights={a.insights} currency={currency} />
        </tr>
      ))}
    </Table>
  );
}
