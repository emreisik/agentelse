"use server";

import { markMetaCredentialExpiredOn } from "@/server/integrations/meta-credential-health";
import { AdsFlags } from "@/lib/ads/flags";
import { prisma } from "@/lib/prisma";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { AdsSync } from "@/server/ads/sync/runner";
import {
  pauseAllAdsAction,
  type PauseResult,
} from "@/server/actions/ads-guard-actions";
import { buildAdsDigest } from "@/lib/works/ads-insight";
import { copyText } from "@/lib/works/copy";
import {
  META_PROVIDER,
  MetaApiError,
} from "@/server/integrations/meta-client";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import { digestForAccount, readAdsDigest } from "@/server/works/ads-pulse";
import {
  authorizeWorks,
  guardedAction,
  refreshWorkPages,
  validId,
  type GuardFail,
} from "@/server/works/guard";

// Click-triggered "Check performance" of the Meta Ads card (spec 3.12.3).
// Read-only: two Graph reads, no Task, no LLM, no chat row (the card is live).
// It persists ONLY metadata.adsDigest with one atomic key-level statement, so
// it can never revert another metadata key (e.g. selectedAdAccountId changed
// meanwhile, or the scanner's own write).

export type RefreshAdsPulseResult =
  | { ok: true; state: "refreshed" | "throttled" }
  | {
      ok: false;
      code: "THROTTLED" | "RECONNECT" | "NOT_CONNECTED";
      message: string;
    }
  | GuardFail;

const BUCKET = { bucket: "ads-pulse", limit: 6 } as const;
// A digest younger than this is returned as is, without a Graph call.
const THROTTLE_MS = 5 * 60_000;
const META_TOKEN_ERROR = 190;

type StoredMetadata = {
  selectedAdAccountId?: unknown;
  adAccounts?: unknown;
  adsDigest?: unknown;
};

function accountCurrency(metadata: StoredMetadata, adAccountId: string): string {
  if (!Array.isArray(metadata.adAccounts)) return "";
  for (const raw of metadata.adAccounts as unknown[]) {
    if (raw === null || typeof raw !== "object") continue;
    const account = raw as { adAccountId?: unknown; currency?: unknown };
    if (
      account.adAccountId === adAccountId &&
      typeof account.currency === "string"
    ) {
      return account.currency;
    }
  }
  return "";
}

export async function refreshAdsPulseAction(
  projectId: string,
  workId: string,
): Promise<RefreshAdsPulseResult> {
  return guardedAction(
    "ads-pulse",
    async (): Promise<RefreshAdsPulseResult> => {
      const gate = await authorizeWorks(projectId, BUCKET);
      if (!gate.ok) return gate;
      if (!validId(workId)) {
        return { ok: false, code: "NOT_FOUND", message: "Work not found." };
      }

      // Looked up WITH the project id: a Work of another project never matches.
      const work = await prisma.work.findFirst({
        where: { id: workId, projectId },
        select: { id: true },
      });
      if (!work) {
        return { ok: false, code: "NOT_FOUND", message: "Work not found." };
      }

      // F2: with the mirror on, "Check performance" refreshes the mirror
      // (P1 lane, at most every 5 minutes per account) instead of writing a
      // digest of its own; the card then reads the mirror.
      if (AdsFlags.sync()) {
        const mirror = await AdsMirror.accountFor(projectId);
        if (mirror?.lastStructureAt) {
          const state = await AdsSync.refreshNow(projectId);
          if (state === "refreshed") {
            refreshWorkPages(projectId);
            return { ok: true, state: "refreshed" };
          }
          return { ok: true, state: "throttled" };
        }
      }

      // No decryption here: the id and the stored digest only.
      const credential = await prisma.integrationCredential.findUnique({
        where: {
          projectId_provider: { projectId, provider: META_PROVIDER.ads },
        },
        select: { id: true, status: true, metadata: true },
      });
      if (!credential || credential.status !== "ACTIVE") {
        return {
          ok: false,
          code: "NOT_CONNECTED",
          message: copyText("ads.state.needsConnect"),
        };
      }
      const metadata = (credential.metadata ?? {}) as StoredMetadata;
      // A digest of another ad account (the owner switched accounts) neither
      // throttles the refresh nor feeds the "vs last check" comparison.
      const stored = digestForAccount(
        readAdsDigest(metadata.adsDigest),
        typeof metadata.selectedAdAccountId === "string" &&
          metadata.selectedAdAccountId.length > 0
          ? metadata.selectedAdAccountId
          : undefined,
      );
      const age = stored ? Date.now() - new Date(stored.at).getTime() : NaN;
      if (stored && age >= 0 && age < THROTTLE_MS) {
        return { ok: true, state: "throttled" };
      }

      try {
        const conn = await MetaAdsQuery.resolveConnection(projectId);
        if (conn.status === "NOT_CONNECTED") {
          return {
            ok: false,
            code: "NOT_CONNECTED",
            message: copyText("ads.state.needsConnect"),
          };
        }
        if (conn.status === "NO_AD_ACCOUNT") {
          return {
            ok: false,
            code: "NOT_CONNECTED",
            message: copyText("ads.state.needsAccount"),
          };
        }

        const campaigns = await MetaAdsQuery.campaigns(conn, "last_7d", {
          preferLeadForLeadsCampaigns: true,
        });
        const insights: Record<
          string,
          NonNullable<(typeof campaigns)[number]["insights"]>
        > = {};
        for (const campaign of campaigns) {
          if (campaign.insights) insights[campaign.campaignId] = campaign.insights;
        }
        // "+x% vs last check": the previous check is the stored digest.
        const previousSnapshot: Record<
          string,
          { costPerResult?: number; resultLabel?: string }
        > = {};
        for (const row of stored?.campaigns ?? []) {
          previousSnapshot[`meta-campaign:${row.id}`] = {
            costPerResult: row.costPerResult,
            resultLabel: row.resultLabel,
          };
        }
        const digest = {
          ...buildAdsDigest({
            insights,
            previousSnapshot,
            campaigns,
            currency:
              accountCurrency(metadata, conn.adAccountId) ||
              stored?.currency ||
              "",
            now: new Date(),
          }),
          // Binds the numbers to the account they were read from.
          adAccountId: conn.adAccountId,
        };

        // ONE atomic statement on its own key: never a whole-metadata write.
        await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{adsDigest}', ${JSON.stringify(digest)}::jsonb) WHERE id = ${credential.id} AND status = 'ACTIVE'`;
      } catch (error) {
        if (
          error instanceof MetaApiError &&
          error.metaErrorCode === META_TOKEN_ERROR
        ) {
          // The connection itself says so too (F0b): the Integrations tile
          // asks for a reconnect.
          await markMetaCredentialExpiredOn(error, credential.id);
          return {
            ok: false,
            code: "RECONNECT",
            message: copyText("ads.reconnect"),
          };
        }
        console.error(
          "[works] ads-pulse read failed:",
          error instanceof Error ? error.message : error,
        );
        return { ok: false, code: "FAILED", message: copyText("ads.failed") };
      }

      refreshWorkPages(projectId);
      return { ok: true, state: "refreshed" };
    },
  );
}

// The Meta Ads card's "Pause all" (F2): the same safety action as the Ads
// page, so the card keeps one actions module.
export async function pauseAllAdsFromCardAction(
  projectId: string,
): Promise<PauseResult> {
  return pauseAllAdsAction(projectId);
}
