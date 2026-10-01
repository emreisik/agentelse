import "server-only";

import { prisma } from "@/lib/prisma";
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

export async function loadAdsPulse(projectId: string): Promise<AdsPulse> {
  const [credential, proposals] = await Promise.all([
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
  ]);
  return { ...credential, proposals };
}
