import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Megaphone, Plug, Plus } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import type { MetaCredentialMetadata } from "@/server/integrations/meta-client";
import {
  createMetaAdAction,
  createMetaAdSetAction,
  createMetaCampaignAction,
} from "@/server/actions/meta-ads-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
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

  const campaigns = await MetaAdsQuery.campaigns(connection);
  const activeCampaign = campaignId
    ? campaigns.find((c) => c.campaignId === campaignId)
    : undefined;

  const adSets =
    campaignId && activeCampaign
      ? await MetaAdsQuery.adSets(connection, campaignId)
      : [];
  const activeAdSet =
    adSetId && adSets.length
      ? adSets.find((a) => a.adSetId === adSetId)
      : undefined;

  const ads =
    adSetId && activeAdSet ? await MetaAdsQuery.ads(connection, adSetId) : [];

  const create = typeof sp.create === "string" ? sp.create : undefined;
  const brief = typeof sp.brief === "string" ? sp.brief : undefined;
  const currentUrl = new URLSearchParams();
  if (campaignId) currentUrl.set("campaignId", campaignId);
  if (adSetId) currentUrl.set("adSetId", adSetId);
  const closeHref = currentUrl.toString()
    ? `${base}?${currentUrl.toString()}`
    : base;
  const createParams = new URLSearchParams(currentUrl);
  createParams.set("create", "campaign");
  const createCampaignHref = `${base}?${createParams.toString()}`;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div className="flex items-start justify-between gap-3">
          <Header projectName={project.name} />
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
              href={`${base}?campaignId=${campaignId}&create=adset`}
              className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
            >
              <Plus className="size-4" />
              New Ad Set
            </Link>
          ) : activeAdSet ? (
            <Link
              href={`${base}?campaignId=${campaignId}&adSetId=${adSetId}&create=ad`}
              className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
            >
              <Plus className="size-4" />
              New Ad
            </Link>
          ) : null}
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
          <AdsTable ads={ads} />
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

const OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
];

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
      description="Creates a draft (paused) campaign — requires approval before it goes live on Meta."
      size="md"
      bodyClassName="space-y-3 overflow-y-auto p-4"
    >
      <ActionForm
        action={createMetaCampaignAction}
        successMessage="Campaign submitted for approval"
        className="space-y-3"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <Field label="Name">
          <Input
            name="name"
            required
            defaultValue={prefillName}
            placeholder="Summer sale — traffic"
          />
        </Field>
        <Field label="Objective">
          <select
            name="objective"
            required
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
          >
            {OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Daily budget">
          <Input
            name="dailyBudget"
            type="number"
            min="1"
            step="0.01"
            required
            placeholder="20.00"
          />
        </Field>
        <div className="flex justify-end pt-1">
          <SubmitButton size="sm">Create Campaign</SubmitButton>
        </div>
      </ActionForm>
    </EntityDialog>
  );
}

const OPTIMIZATION_GOALS = [
  "LINK_CLICKS",
  "IMPRESSIONS",
  "REACH",
  "LANDING_PAGE_VIEWS",
  "POST_ENGAGEMENT",
];
const BILLING_EVENTS = ["IMPRESSIONS", "LINK_CLICKS"];

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
      title="New Ad Set"
      description="Targeting, budget and scheduling for this campaign — requires approval."
      size="md"
      bodyClassName="space-y-3 overflow-y-auto p-4"
    >
      <ActionForm
        action={createMetaAdSetAction}
        successMessage="Ad set submitted for approval"
        className="space-y-3"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="campaignId" value={campaignId} />
        <Field label="Name">
          <Input name="name" required placeholder="US — 25-45" />
        </Field>
        <Field label="Daily budget">
          <Input
            name="dailyBudget"
            type="number"
            min="1"
            step="0.01"
            required
            placeholder="10.00"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Billing event">
            <select
              name="billingEvent"
              required
              className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
            >
              {BILLING_EVENTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Optimization goal">
            <select
              name="optimizationGoal"
              required
              className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
            >
              {OPTIMIZATION_GOALS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Countries (comma-separated ISO codes)">
          <Input name="countries" required placeholder="US, CA" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Min age">
            <Input
              name="ageMin"
              type="number"
              min="13"
              max="65"
              placeholder="18"
            />
          </Field>
          <Field label="Max age">
            <Input
              name="ageMax"
              type="number"
              min="13"
              max="65"
              placeholder="65"
            />
          </Field>
        </div>
        <div className="flex justify-end pt-1">
          <SubmitButton size="sm">Create Ad Set</SubmitButton>
        </div>
      </ActionForm>
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

function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function statusTone(status: string): "positive" | "waiting" | "neutral" {
  if (status === "ACTIVE") return "positive";
  if (status === "PAUSED") return "waiting";
  return "neutral";
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
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3.5 py-2 text-left font-medium">
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
      columns={["Name", "Objective", "Status", "Daily budget"]}
      empty={campaigns.length === 0}
    >
      {campaigns.map((c) => (
        <tr key={c.campaignId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5">
            <Link
              href={`${base}?campaignId=${c.campaignId}`}
              className="font-medium text-foreground hover:underline"
            >
              {c.name}
            </Link>
          </td>
          <td className="px-3.5 py-2.5 text-muted-foreground">{c.objective}</td>
          <td className="px-3.5 py-2.5">
            <StatusBadge
              meta={{ label: c.effectiveStatus, tone: statusTone(c.status) }}
            />
          </td>
          <td className="px-3.5 py-2.5 text-muted-foreground">
            {formatMoney(c.dailyBudgetCents, currency)}
          </td>
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
      columns={["Name", "Optimization goal", "Status", "Daily budget"]}
      empty={adSets.length === 0}
    >
      {adSets.map((a) => (
        <tr key={a.adSetId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5">
            <Link
              href={`${base}?campaignId=${campaignId}&adSetId=${a.adSetId}`}
              className="font-medium text-foreground hover:underline"
            >
              {a.name}
            </Link>
          </td>
          <td className="px-3.5 py-2.5 text-muted-foreground">
            {a.optimizationGoal ?? "—"}
          </td>
          <td className="px-3.5 py-2.5">
            <StatusBadge
              meta={{ label: a.effectiveStatus, tone: statusTone(a.status) }}
            />
          </td>
          <td className="px-3.5 py-2.5 text-muted-foreground">
            {formatMoney(a.dailyBudgetCents, currency)}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function AdsTable({
  ads,
}: {
  ads: Awaited<ReturnType<typeof MetaAdsQuery.ads>>;
}) {
  return (
    <Table columns={["Name", "Status"]} empty={ads.length === 0}>
      {ads.map((a) => (
        <tr key={a.adId} className="hover:bg-muted/30">
          <td className="px-3.5 py-2.5 font-medium text-foreground">
            {a.name}
          </td>
          <td className="px-3.5 py-2.5">
            <StatusBadge
              meta={{ label: a.effectiveStatus, tone: statusTone(a.status) }}
            />
          </td>
        </tr>
      ))}
    </Table>
  );
}
