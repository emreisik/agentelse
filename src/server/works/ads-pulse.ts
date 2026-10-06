import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { isDelivering } from "@/lib/ads/mirror";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsMirror } from "@/server/ads/mirror-reads";
import {
  MAX_DIGEST_CAMPAIGNS,
  type AdsDigest,
  type AdsDigestCampaign,
  type AdsProposalCapability,
  type AdsPulse,
  type AdsPulseProposal,
} from "@/lib/works/ads-insight";
import { META_PROVIDER } from "@/server/integrations/meta-client";

// The data the Meta Ads card reads (spec 3.12.2): ONE credential read WITHOUT
// decrypting the secret, plus the pending spend proposals. Zero network, no
// LLM, never throws: a failed read degrades to the emptiest honest state.

const SPEND_CAPABILITIES: AdsProposalCapability[] = [
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_UPDATE",
];
const MAX_PROPOSALS = 20;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// The digest is stored JSON written by two writers: read it defensively and
// keep only what the card can use. A malformed digest counts as absent.
export function readAdsDigest(value: unknown): AdsDigest | null {
  const digest = asObject(value);
  if (!digest) return null;
  const at = text(digest.at);
  if (!at || !Array.isArray(digest.campaigns)) return null;
  const campaigns: AdsDigestCampaign[] = [];
  for (const raw of digest.campaigns) {
    const row = asObject(raw);
    const id = text(row?.id);
    const name = text(row?.name);
    const dailyBudgetCents = num(row?.dailyBudgetCents);
    const spend = num(row?.spend);
    if (!row || !id || !name) continue;
    if (dailyBudgetCents === undefined || spend === undefined) continue;
    const resultLabel = text(row.resultLabel);
    const resultCount = num(row.resultCount);
    const costPerResult = num(row.costPerResult);
    const prevCostPerResult = num(row.prevCostPerResult);
    const costChangePct = num(row.costChangePct);
    const ctr = num(row.ctr);
    campaigns.push({
      id,
      name,
      dailyBudgetCents,
      spend,
      ...(resultLabel ? { resultLabel } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
      ...(costPerResult !== undefined ? { costPerResult } : {}),
      ...(prevCostPerResult !== undefined ? { prevCostPerResult } : {}),
      ...(costChangePct !== undefined ? { costChangePct } : {}),
      ...(ctr !== undefined ? { ctr } : {}),
    });
  }
  const adAccountId = text(digest.adAccountId);
  return {
    at,
    currency: text(digest.currency) ?? "",
    campaigns: campaigns.slice(0, MAX_DIGEST_CAMPAIGNS),
    ...(adAccountId ? { adAccountId } : {}),
  };
}

// The digest is only valid for the ad account it was read from. After the
// owner switches accounts, the old campaigns, budgets and currency must not be
// shown (or throttle a refresh) until a scan or refresh replaces the digest.
// A digest with no account stamp cannot be proven to belong to the selected
// account, so it counts as absent.
export function digestForAccount(
  digest: AdsDigest | null,
  selectedAdAccountId: string | undefined,
): AdsDigest | null {
  if (!digest) return null;
  if (!selectedAdAccountId) return digest;
  return digest.adAccountId === selectedAdAccountId ? digest : null;
}

// Reads the STRUCTURED payload the optimizer wrote, never the detail strings.
function proposalFrom(
  task: { id: string; capability: string; payload: unknown },
  approvalId: string,
): AdsPulseProposal | null {
  const capability = SPEND_CAPABILITIES.find((c) => c === task.capability);
  if (!capability) return null;
  const payload = asObject(task.payload) ?? {};
  const campaignId = text(payload.campaignId);
  const campaignName = text(payload.campaignName);
  const current = num(payload.currentDailyBudgetCents);
  const proposed = num(payload.proposedDailyBudgetCents);
  const status = text(payload.proposedStatus);
  const reason = text(payload.reason);
  return {
    taskId: task.id,
    approvalId,
    capability,
    ...(campaignId ? { campaignId } : {}),
    ...(campaignName ? { campaignName } : {}),
    ...(current !== undefined ? { currentDailyBudgetCents: current } : {}),
    ...(proposed !== undefined ? { proposedDailyBudgetCents: proposed } : {}),
    ...(status ? { proposedStatus: status } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function loadProposals(projectId: string): Promise<AdsPulseProposal[]> {
  const approvals = await prisma.approval.findMany({
    where: { projectId, status: "PENDING", entityType: "Task" },
    orderBy: { createdAt: "asc" },
    select: { id: true, entityId: true },
    take: 100,
  });
  if (approvals.length === 0) return [];
  const approvalByTask = new Map(approvals.map((a) => [a.entityId, a.id]));
  const tasks = await prisma.task.findMany({
    where: {
      id: { in: [...approvalByTask.keys()] },
      projectId,
      capability: { in: SPEND_CAPABILITIES },
    },
    select: { id: true, capability: true, payload: true },
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const proposals: AdsPulseProposal[] = [];
  // Keep the approvals' order (oldest first).
  for (const [taskId, approvalId] of approvalByTask) {
    const task = taskById.get(taskId);
    const proposal = task ? proposalFrom(task, approvalId) : null;
    if (proposal) proposals.push(proposal);
    if (proposals.length >= MAX_PROPOSALS) break;
  }
  return proposals;
}

async function loadCredential(
  projectId: string,
): Promise<Omit<AdsPulse, "proposals">> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.ads },
    },
    select: { status: true, metadata: true },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return { connected: false, hasAccount: false };
  }
  const metadata = asObject(credential.metadata) ?? {};
  const lastScanAt = text(metadata.lastAdsPerformanceScanAt);
  const failureCount = num(metadata.adsPerformanceScanFailureCount);
  const selectedAdAccountId = text(metadata.selectedAdAccountId);
  return {
    connected: true,
    hasAccount: selectedAdAccountId !== undefined,
    digest: digestForAccount(
      readAdsDigest(metadata.adsDigest),
      selectedAdAccountId,
    ),
    ...(lastScanAt ? { lastScanAt } : {}),
    ...(failureCount !== undefined ? { failureCount } : {}),
  };
}

// META_ADS_SYNC açıkken kartın rakamları aynadan gelir (docs/meta-ads-plan.md
// F2): son 7 günün kampanya toplamları, açık uyarılar ve çalışan kampanya
// sayısı ("Pause all"). Ayna yoksa ya da hiç senkronlanmamışsa null.
async function loadMirror(
  projectId: string,
  now: Date,
): Promise<Pick<AdsPulse, "digest" | "lastScanAt" | "failureCount" | "alerts" | "runningCampaigns" | "staleAfterMs"> | null> {
  if (!AdsFlags.sync()) return null;
  const account = await AdsMirror.accountFor(projectId);
  if (!account?.lastStructureAt) return null;
  const [campaigns, insights, alerts] = await Promise.all([
    AdsMirror.objects(account, "CAMPAIGN"),
    AdsMirror.insightsByObject(account, "CAMPAIGN", "last_7d", { now }),
    AdsAlerts.listOpen(projectId, 5),
  ]);
  const adSets = await AdsMirror.objects(account, "ADSET");
  const running = campaigns.filter(
    (campaign) =>
      campaign.configuredStatus === "ACTIVE" &&
      (!campaign.endTime || campaign.endTime.getTime() > now.getTime()),
  );
  const rows: AdsDigestCampaign[] = [];
  for (const campaign of running) {
    const row = insights.get(campaign.externalId);
    if (!row || row.spend <= 0) continue;
    const own = campaign.dailyBudgetMinor === null ? 0 : Number(campaign.dailyBudgetMinor);
    const children = adSets
      .filter((adSet) => adSet.campaignExternalId === campaign.externalId && isDelivering(adSet, now))
      .reduce((sum, adSet) => sum + Number(adSet.dailyBudgetMinor ?? 0), 0);
    rows.push({
      id: campaign.externalId,
      name: nameWithoutTag(campaign.name),
      dailyBudgetCents: own || children,
      spend: row.spend,
      ...(row.resultLabel ? { resultLabel: row.resultLabel } : {}),
      ...(row.resultCount !== undefined ? { resultCount: row.resultCount } : {}),
      ...(row.costPerResult !== undefined ? { costPerResult: row.costPerResult } : {}),
      ...(row.ctr ? { ctr: row.ctr } : {}),
    });
  }
  rows.sort((a, b) => b.spend - a.spend);
  const at = (account.lastInsightsAt ?? account.lastStructureAt).toISOString();
  return {
    digest: {
      at,
      currency: account.currency ?? "",
      campaigns: rows.slice(0, MAX_DIGEST_CAMPAIGNS),
      adAccountId: account.externalId,
    },
    lastScanAt: at,
    failureCount: account.consecutiveFailures,
    runningCampaigns: running.length,
    // Teslimat sürerken ayna 30 dakikada bir tazelenir: 2 saatten eskisi bayat.
    staleAfterMs: running.length > 0 ? 2 * 60 * 60_000 : undefined,
    alerts: alerts
      .filter((alert) => alert.severity !== "INFO")
      .slice(0, 3)
      .map((alert) => ({
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
      })),
  };
}

export async function loadAdsPulse(
  projectId: string,
  now: Date = new Date(),
): Promise<AdsPulse> {
  const [credential, proposals, mirror] = await Promise.all([
    loadCredential(projectId).catch((error: unknown) => {
      console.error(
        "[works] ads pulse credential read failed:",
        error instanceof Error ? error.message : error,
      );
      return { connected: false, hasAccount: false } as const;
    }),
    loadProposals(projectId).catch((error: unknown) => {
      console.error(
        "[works] ads pulse proposals read failed:",
        error instanceof Error ? error.message : error,
      );
      return [] as AdsPulseProposal[];
    }),
    loadMirror(projectId, now).catch((error: unknown) => {
      console.error(
        "[works] ads pulse mirror read failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
  ]);
  if (mirror && credential.connected && credential.hasAccount) {
    return { ...credential, ...mirror, proposals };
  }
  return { ...credential, proposals };
}
