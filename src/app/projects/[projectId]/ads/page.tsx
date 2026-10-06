import { formatMoney as formatMinorMoney } from "@/lib/ads/money";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ChevronRight,
  Eye,
  Megaphone,
  Plug,
  Plus,
} from "lucide-react";

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
import {
  META_PROVIDER,
  type MetaAdsMetadata,
  type MetaInsightsRow,
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
import { CampaignDetailSheet } from "@/components/ads/campaign-detail-sheet";
import { AdSetDetailSheet } from "@/components/ads/adset-detail-sheet";
import { AdDetailSheet } from "@/components/ads/ad-detail-sheet";
import { CampaignEditForm } from "@/components/ads/campaign-edit-form";
import { AdSetEditWizard } from "@/components/ads/adset-edit-wizard";
import { AdEditWizard } from "@/components/ads/ad-edit-wizard";
import { cn } from "@/lib/utils";
import { AdsFlags } from "@/lib/ads/flags";
import { isModulesEnabled } from "@/server/works/flag";
import { deliveryLabel } from "@/lib/ads/mirror";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { AdsAccountStatus } from "@/components/ads/ads-account-status";
import { loadAdsAccountStatus } from "@/server/ads/status";

// MetaApiError and network failures land here uncaught otherwise (see the
// isolated try/catch around each drill-down level's fetch below) — safe to
// surface as-is, it's Meta's own descriptive text, never the access token.
function metaErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Failed to load data from Meta.";
}

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
              href={`/projects/${projectId}/integrations?integration=meta_ads`}
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
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.ads },
    },
  });
  const metadata = (credential?.metadata ?? {}) as MetaAdsMetadata;
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

  // Each level's fetch is isolated in its own try/catch: a Meta API error at
  // any level (rate limit, expired token, an object deleted on Meta's side
  // between listing and drill-down) used to propagate uncaught out of this
  // RSC render and take down the whole page with a generic 500. Now it
  // degrades to a retry prompt for just that level instead.
  let campaigns: Awaited<ReturnType<typeof MetaAdsQuery.campaigns>> = [];
  let campaignsError: string | null = null;
  try {
    campaigns = await MetaAdsQuery.campaigns(connection, datePreset);
  } catch (error) {
    // 190: the connection is marked for a reconnect (F0b).
    await MetaAdsQuery.noteFailure(connection, error);
    campaignsError = metaErrorMessage(error);
  }
  const activeCampaign = campaignId
    ? campaigns.find((c) => c.campaignId === campaignId)
    : undefined;

  let adSets: Awaited<ReturnType<typeof MetaAdsQuery.adSets>> = [];
  let adSetsError: string | null = null;
  if (campaignId && activeCampaign) {
    try {
      adSets = await MetaAdsQuery.adSets(connection, campaignId, datePreset);
    } catch (error) {
      await MetaAdsQuery.noteFailure(connection, error);
      adSetsError = metaErrorMessage(error);
    }
  }
  const activeAdSet =
    adSetId && adSets.length
      ? adSets.find((a) => a.adSetId === adSetId)
      : undefined;

  let ads: Awaited<ReturnType<typeof MetaAdsQuery.ads>> = [];
  let adsError: string | null = null;
  if (adSetId && activeAdSet) {
    try {
      ads = await MetaAdsQuery.ads(connection, adSetId, datePreset);
    } catch (error) {
      await MetaAdsQuery.noteFailure(connection, error);
      adsError = metaErrorMessage(error);
    }
  }

  // F3: modüller ve güvenli lansman v2 açıkken eski oluşturma formları gizli;
  // reklam Ads kartında tek onayla kurulur.
  const legacyFormsHidden = isModulesEnabled() && AdsFlags.launchV2();

  // Ayna açıkken hesap sağlığı, tazelik, uyarılar ve Pause all.
  const accountStatus = AdsFlags.sync()
    ? await loadAdsAccountStatus(projectId).catch(() => null)
    : null;

  const create = typeof sp.create === "string" ? sp.create : undefined;
  const brief = typeof sp.brief === "string" ? sp.brief : undefined;
  const campaignDetailId =
    typeof sp.campaignDetail === "string" ? sp.campaignDetail : undefined;
  const adSetDetailId =
    typeof sp.adsetDetail === "string" ? sp.adsetDetail : undefined;
  const adDetailId = typeof sp.adDetail === "string" ? sp.adDetail : undefined;
  const campaignEditId =
    typeof sp.campaignEdit === "string" ? sp.campaignEdit : undefined;
  const adSetEditId =
    typeof sp.adsetEdit === "string" ? sp.adsetEdit : undefined;
  const adEditId = typeof sp.adEdit === "string" ? sp.adEdit : undefined;
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

  // Detail-sheet hrefs are built the same way as create-dialog hrefs
  // (currentUrl + one extra param) so opening/closing a detail sheet never
  // disturbs the drill-down level (campaignId/adSetId) or date range.
  function detailHref(
    param: "campaignDetail" | "adsetDetail" | "adDetail",
    id: string,
  ) {
    const params = new URLSearchParams(currentUrl);
    params.set(param, id);
    return `${base}?${params.toString()}`;
  }
  function editHref(
    param: "campaignEdit" | "adsetEdit" | "adEdit",
    id: string,
  ) {
    const params = new URLSearchParams(currentUrl);
    params.set(param, id);
    return `${base}?${params.toString()}`;
  }

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
            {legacyFormsHidden ? (
              <Link
                href={`/projects/${projectId}?module=ads`}
                className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
              >
                <Plus className="size-4" />
                Create an ad
              </Link>
            ) : !campaignId ? (
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

        {accountStatus ? (
          <AdsAccountStatus projectId={projectId} {...accountStatus} />
        ) : null}

        <Breadcrumb base={base} campaign={activeCampaign} adSet={activeAdSet} />

        {campaignsError ? (
          <LoadErrorState message={campaignsError} />
        ) : !campaignId ? (
          <CampaignsTable
            base={base}
            campaigns={campaigns}
            currency={currency}
            detailHref={(id) => detailHref("campaignDetail", id)}
          />
        ) : !activeCampaign ? (
          <EmptyState
            icon={Megaphone}
            title="Campaign not found"
            hint="It may have been deleted or renamed on Meta's side."
            className="py-16"
          />
        ) : adSetsError ? (
          <LoadErrorState message={adSetsError} />
        ) : !adSetId ? (
          <AdSetsTable
            base={base}
            campaignId={campaignId}
            adSets={adSets}
            currency={currency}
            detailHref={(id) => detailHref("adsetDetail", id)}
          />
        ) : !activeAdSet ? (
          <EmptyState
            icon={Megaphone}
            title="Ad set not found"
            hint="It may have been deleted or renamed on Meta's side."
            className="py-16"
          />
        ) : adsError ? (
          <LoadErrorState message={adsError} />
        ) : (
          <AdsTable
            ads={ads}
            currency={currency}
            detailHref={(id) => detailHref("adDetail", id)}
          />
        )}

        {create === "campaign" && !legacyFormsHidden ? (
          <CreateCampaignDialog
            projectId={projectId}
            closeHref={closeHref}
            prefillName={brief}
          />
        ) : null}
        {create === "adset" && campaignId && !legacyFormsHidden ? (
          <CreateAdSetDialog
            projectId={projectId}
            campaignId={campaignId}
            closeHref={closeHref}
            pageName={metadata.selectedPageName ?? "Your Page"}
          />
        ) : null}
        {create === "ad" && adSetId && !legacyFormsHidden ? (
          <CreateAdDialog
            projectId={projectId}
            adSetId={adSetId}
            closeHref={closeHref}
          />
        ) : null}

        {campaignDetailId
          ? (() => {
              const campaign = campaigns.find(
                (c) => c.campaignId === campaignDetailId,
              );
              return campaign ? (
                <CampaignDetailSheet
                  campaign={campaign}
                  currency={currency}
                  closeHref={closeHref}
                  editHref={editHref("campaignEdit", campaignDetailId)}
                />
              ) : null;
            })()
          : null}
        {adSetDetailId
          ? (() => {
              const adSet = adSets.find((a) => a.adSetId === adSetDetailId);
              return adSet ? (
                <AdSetDetailSheet
                  adSet={adSet}
                  currency={currency}
                  closeHref={closeHref}
                  editHref={editHref("adsetEdit", adSetDetailId)}
                />
              ) : null;
            })()
          : null}
        {adDetailId
          ? (() => {
              const ad = ads.find((a) => a.adId === adDetailId);
              return ad ? (
                <AdDetailSheet
                  ad={ad}
                  pageName={metadata.selectedPageName ?? "Your Page"}
                  closeHref={closeHref}
                  editHref={editHref("adEdit", adDetailId)}
                />
              ) : null;
            })()
          : null}

        {campaignEditId
          ? (() => {
              const campaign = campaigns.find(
                (c) => c.campaignId === campaignEditId,
              );
              return campaign ? (
                <EntityDialog
                  closeHref={closeHref}
                  title={`Edit ${campaign.name}`}
                  description="Budget and status — requires approval."
                  size="md"
                  bodyClassName="overflow-y-auto p-4"
                >
                  <CampaignEditForm
                    projectId={projectId}
                    campaign={campaign}
                    currency={currency}
                  />
                </EntityDialog>
              ) : null;
            })()
          : null}
        {adSetEditId
          ? (() => {
              const adSet = adSets.find((a) => a.adSetId === adSetEditId);
              return adSet ? (
                <EntityDialog
                  closeHref={closeHref}
                  title={`Edit ${adSet.name}`}
                  description="Budget, status and targeting — requires approval."
                  size="full"
                  bodyClassName="overflow-y-auto p-6"
                >
                  <AdSetEditWizard
                    projectId={projectId}
                    adSet={adSet}
                    closeHref={closeHref}
                    currency={currency}
                  />
                </EntityDialog>
              ) : null;
            })()
          : null}
        {adEditId
          ? (() => {
              const ad = ads.find((a) => a.adId === adEditId);
              return ad ? (
                <EntityDialog
                  closeHref={closeHref}
                  title={`Edit ${ad.name}`}
                  description="Creative, copy and status — requires approval."
                  size="full"
                  bodyClassName="overflow-y-auto p-6"
                >
                  <AdEditWizard
                    projectId={projectId}
                    ad={ad}
                    closeHref={closeHref}
                    pageName={metadata.selectedPageName ?? "Your Page"}
                  />
                </EntityDialog>
              ) : null;
            })()
          : null}
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
  pageName,
}: {
  projectId: string;
  campaignId: string;
  closeHref: string;
  pageName: string;
}) {
  return (
    <EntityDialog
      closeHref={closeHref}
      title="New Ad Set + Ad"
      description="Targeting, budget and one ad's creative — both require approval."
      size="full"
      bodyClassName="overflow-y-auto p-6"
    >
      <AdSetAdWizard
        projectId={projectId}
        campaignId={campaignId}
        closeHref={closeHref}
        pageName={pageName}
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

function LoadErrorState({ message }: { message: string }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Couldn't load from Meta"
      hint={message}
      className="py-16"
    >
      <p className="text-xs text-muted-foreground">
        Reload the page to try again.
      </p>
    </EmptyState>
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
// Minor unit'ten, hesabın para birimi ofsetiyle (src/lib/ads/money.ts):
// sabit /100 JPY/HUF gibi hesaplarda 100 kat yanlış gösteriyordu.
function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return "—";
  return formatMinorMoney(cents, currency);
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
  detailHref,
}: {
  base: string;
  campaigns: Awaited<ReturnType<typeof MetaAdsQuery.campaigns>>;
  currency: string;
  detailHref: (id: string) => string;
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
            <div className="flex items-center gap-1.5">
              <Link
                href={`${base}?campaignId=${c.campaignId}`}
                className="font-medium text-foreground hover:underline"
              >
                {nameWithoutTag(c.name)}
              </Link>
              {c.createdByAgentelse ? (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Agentelse
                </span>
              ) : null}
              <Link
                href={detailHref(c.campaignId)}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={`View details for ${c.name}`}
              >
                <Eye className="size-3.5" />
              </Link>
            </div>
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap text-muted-foreground">
            {c.objective}
          </td>
          <td className="px-3.5 py-2.5 whitespace-nowrap">
            <StatusBadge
              meta={{
                // Aynadan okunurken Meta durumu okunur etikete çevrilir
                // ("Completed", "Paused by you", "Stopped by Meta").
                label:
                  c.endTime !== undefined
                    ? deliveryLabel({
                        configuredStatus: c.status,
                        effectiveStatus: c.effectiveStatus,
                        endTime: c.endTime ? new Date(c.endTime) : null,
                      })
                    : c.effectiveStatus,
                tone: statusTone(c.status),
              }}
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
  detailHref,
}: {
  base: string;
  campaignId: string;
  adSets: Awaited<ReturnType<typeof MetaAdsQuery.adSets>>;
  currency: string;
  detailHref: (id: string) => string;
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
            <div className="flex items-center gap-1.5">
              <Link
                href={`${base}?campaignId=${campaignId}&adSetId=${a.adSetId}`}
                className="font-medium text-foreground hover:underline"
              >
                {a.name}
              </Link>
              <Link
                href={detailHref(a.adSetId)}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={`View details for ${a.name}`}
              >
                <Eye className="size-3.5" />
              </Link>
            </div>
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
  detailHref,
}: {
  ads: Awaited<ReturnType<typeof MetaAdsQuery.ads>>;
  currency: string;
  detailHref: (id: string) => string;
}) {
  return (
    <Table
      columns={["Name", "Status", ...REPORTING_COLUMNS]}
      empty={ads.length === 0}
    >
      {ads.map((a) => (
        <tr key={a.adId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5 font-medium whitespace-nowrap text-foreground">
            <div className="flex items-center gap-1.5">
              <Link href={detailHref(a.adId)} className="hover:underline">
                {a.name}
              </Link>
              <Link
                href={detailHref(a.adId)}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={`View details for ${a.name}`}
              >
                <Eye className="size-3.5" />
              </Link>
            </div>
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
