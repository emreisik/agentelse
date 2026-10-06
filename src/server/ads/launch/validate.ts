import "server-only";

import type { AdsLaunch, Prisma } from "@prisma/client";

import { normalizeAdAccountId } from "@/lib/ads/account-id";
import {
  blockingIssues,
  envelopeMinor,
  specHash,
  validateLaunchSpec,
  type AdsLaunchSpec,
  type LaunchAccountFacts,
  type LaunchIssue,
} from "@/lib/ads/launch-spec";
import { safeTimezone } from "@/lib/ads/sync-plan";
import type { LaunchBuildContext } from "@/lib/module-flows/ads/launch";
import { prisma } from "@/lib/prisma";
import { AdsAccounts } from "@/server/ads/accounts";
import { adsAccountAssets } from "@/server/ads/account-assets";
import { AdsMirror } from "@/server/ads/mirror-reads";
import {
  MetaApiError,
  uploadMetaAdImage,
} from "@/server/integrations/meta-client";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { metaUserMessage } from "@/server/integrations/meta/error-catalog";
import {
  creativeFeaturesSpec,
  generatePreview,
  objectStorySpec,
  postCampaign,
  postCreative,
} from "@/server/integrations/meta/launch-writes";
import { readAccountHealth } from "@/server/integrations/meta/sync-reads";
import { readAsset } from "@/server/storage/asset-storage";

import { AdsLaunches, progressOf, type LaunchProgress } from "./store";

// Review adımının ön kontrolü (docs/meta-ads-plan.md §3.4 adım 1-4): hesap
// gerçekleri, yerel P kuralları, görsel yükleme (harcamasız, hash idempotent),
// kampanya ve kreatif için Meta `validate_only` ve önizlemeler. Sonuç AdsLaunch
// (VALIDATED ya da sorun varsa DRAFT) satırına yazılır; onay bu satıra verilir.

const FRESH_FACTS_MS = 15 * 60_000;
const PREVIEW_FORMATS = [
  "MOBILE_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
] as const;

export type LaunchValidation = {
  checkedAt: string;
  issues: LaunchIssue[];
  // Bilgi notları (mesaj hedefinde otomatik yanıt, LPV açıklaması...).
  notes: string[];
  previews: { format: string; src: string }[];
  envelopeMinor: number;
  spendCapMinor: number | null;
  timezone: string;
  featuresFallback?: boolean;
};

export type BuildContext = LaunchBuildContext;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

async function accountFacts(
  projectId: string,
  adAccountId: string,
  accessToken: string,
  now: Date,
): Promise<LaunchAccountFacts & { timezone: string | null; minCampaignSpendCapMinor: number | null }> {
  const row = await AdsMirror.accountFor(projectId);
  if (row && row.lastHealthAt && now.getTime() - row.lastHealthAt.getTime() < FRESH_FACTS_MS) {
    return {
      accountStatus: row.accountStatus,
      currency: row.currency,
      minDailyBudgetMinor: row.minDailyBudgetMinor === null ? null : Number(row.minDailyBudgetMinor),
      minimumBudgets: row.minimumBudgets,
      dsaBeneficiary: row.dsaBeneficiary,
      dsaPayor: row.dsaPayor,
      timezone: row.timezoneName,
      minCampaignSpendCapMinor:
        row.minCampaignSpendCapMinor === null ? null : Number(row.minCampaignSpendCapMinor),
    };
  }
  const read = await readAccountHealth(adAccountId, accessToken);
  const facts = {
    accountStatus: typeof read.account_status === "number" ? read.account_status : null,
    currency: typeof read.currency === "string" ? read.currency.toUpperCase() : null,
    minDailyBudgetMinor: num(read.min_daily_budget),
    minimumBudgets: read.minimumBudgets ?? null,
    dsaBeneficiary: read.default_dsa_beneficiary ?? null,
    dsaPayor: read.default_dsa_payor ?? null,
    timezone: read.timezone_name ?? null,
    minCampaignSpendCapMinor: num(read.min_campaign_group_spend_cap),
  };
  if (row) {
    await prisma.adsAccount
      .update({
        where: { id: row.id },
        data: {
          accountStatus: facts.accountStatus,
          timezoneName: facts.timezone ?? row.timezoneName,
          minDailyBudgetMinor: facts.minDailyBudgetMinor === null ? null : BigInt(facts.minDailyBudgetMinor),
          minCampaignSpendCapMinor:
            facts.minCampaignSpendCapMinor === null ? null : BigInt(facts.minCampaignSpendCapMinor),
          ...(facts.minimumBudgets ? { minimumBudgets: facts.minimumBudgets as Prisma.InputJsonValue } : {}),
        },
      })
      .catch(() => undefined);
  }
  return facts;
}

function metaIssue(field: string, error: unknown): LaunchIssue {
  const blame = error instanceof MetaApiError ? (error.details.blameFieldSpecs as unknown) : null;
  const blamed = Array.isArray(blame) && Array.isArray(blame[0]) ? (blame[0] as unknown[]).join(".") : null;
  return {
    rule: "META",
    field: blamed ? `${field}.${blamed}` : field,
    severity: "block",
    message: metaUserMessage(error),
  };
}

function featuresRejected(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  return /degrees_of_freedom|creative_features|contextual_multi_ads/i.test(
    `${error.message} ${JSON.stringify(error.details.blameFieldSpecs ?? "")}`,
  );
}

export type PrepareResult =
  | { ok: true; launch: AdsLaunch; validation: LaunchValidation; spec: AdsLaunchSpec }
  | { ok: false; message: string };

export async function prepareLaunch(input: {
  workspaceId: string;
  projectId: string;
  workId: string | null;
  commandId: string;
  userId: string;
  build: (context: BuildContext) => AdsLaunchSpec;
  now?: Date;
}): Promise<PrepareResult> {
  const now = input.now ?? new Date();
  const account = await AdsAccounts.resolveWithToken(input.projectId);
  if (!("accessToken" in account) || account.status !== "ready" || !account.pageId) {
    return { ok: false, message: "Finish the Meta Ads setup (ad account and Page) first." };
  }
  const adAccountId = normalizeAdAccountId(account.adAccountId);
  return withMetaCallContext(
    { account: adAccountId, lane: "P1_USER", callSite: "launch.prepare" },
    async () => {
      const facts = await accountFacts(input.projectId, adAccountId, account.accessToken, now);
      const currency = facts.currency ?? account.currency ?? null;
      if (!currency) return { ok: false as const, message: "Meta didn't say which currency this ad account uses." };
      // P9: reklam hesabının Instagram kimliği (yoksa Sayfa kimliği).
      const assets = await adsAccountAssets(input.projectId, now).catch(() => null);
      const spec = input.build({
        adAccountId,
        currency,
        timezone: safeTimezone(facts.timezone),
        pageId: account.pageId!,
        ...(assets?.instagramUserId ? { instagramUserId: assets.instagramUserId } : {}),
        minCampaignSpendCapMinor: facts.minCampaignSpendCapMinor,
        dsaBeneficiary: facts.dsaBeneficiary ?? null,
        dsaPayor: facts.dsaPayor ?? null,
      });
      const issues = validateLaunchSpec(spec, facts);

      // Kartın açık (henüz başlatılmamış) lansmanı yeniden kullanılır.
      const latest = await AdsLaunches.latestForCommand(input.commandId);
      const reusable = latest && (latest.status === "DRAFT" || latest.status === "VALIDATED");
      const count = reusable ? 0 : await prisma.adsLaunch.count({ where: { commandId: input.commandId } });
      const progress: LaunchProgress = reusable && latest ? progressOf(latest) : {};
      // Hesap değiştiyse eski hash'ler geçersiz.
      if (latest && reusable && latest.adAccountExternalId !== adAccountId) {
        delete progress.images;
      }

      const messaging = spec.ads.find((ad) => ad.creative.messaging)?.creative.messaging;
      const notes: string[] = [];
      if (messaging) {
        notes.push(
          "Set an Instant Reply and an Away message in Meta Business Suite so people get an answer outside your hours.",
        );
      }
      if (spec.adSets.some((adSet) => adSet.optimizationGoal === "LANDING_PAGE_VIEWS")) {
        notes.push("Meta shows the ad to people likely to wait for your page to load, not just to tap.");
      }
      if (messaging === "INSTAGRAM_DIRECT" && !spec.instagramUserId) {
        issues.push({
          rule: "P9",
          field: "adSets.0.destinationType",
          severity: "block",
          message: "Connect an Instagram account to this ad account to get messages on Instagram.",
        });
      }
      const validation: LaunchValidation = {
        checkedAt: now.toISOString(),
        issues,
        notes,
        previews: [],
        envelopeMinor: envelopeMinor(spec),
        spendCapMinor: spec.guards.campaignSpendCapMinor,
        timezone: spec.timezone,
      };

      if (blockingIssues(issues).length === 0) {
        // Görseller (Review'da yüklenir; yürütücü aynı hash'i kullanır).
        progress.images = progress.images ?? {};
        for (const [index, ad] of spec.ads.entries()) {
          if (progress.images[index]) continue;
          const asset = await prisma.asset.findFirst({
            where: { id: ad.creative.imageAssetId, projectId: input.projectId },
            select: { storageKey: true },
          });
          if (!asset) {
            validation.issues.push({ rule: "P12", field: `ads.${index}.creative`, severity: "block", message: "The ad's picture is gone. Pick the post again." });
            continue;
          }
          try {
            const uploaded = await uploadMetaAdImage({
              adAccountId,
              accessToken: account.accessToken,
              imageBuffer: await readAsset(asset.storageKey),
            });
            progress.images[index] = uploaded.imageHash;
          } catch (error) {
            validation.issues.push(metaIssue(`ads.${index}.creative.image`, error));
          }
        }

        // Meta ön kontrolü: kampanya ve her kreatif (validate_only).
        try {
          await postCampaign({
            adAccountId,
            accessToken: account.accessToken,
            name: spec.campaignName,
            objective: spec.objective,
            specialAdCategories: spec.specialAdCategories,
            spendCapMinor: spec.guards.campaignSpendCapMinor,
            validateOnly: true,
          });
        } catch (error) {
          validation.issues.push(metaIssue("campaign", error));
        }
        for (const [index, ad] of spec.ads.entries()) {
          const hash = progress.images?.[index];
          if (!hash) continue;
          const base = {
            adAccountId,
            accessToken: account.accessToken,
            name: ad.name,
            pageId: spec.pageId,
            instagramUserId: spec.instagramUserId,
            imageHash: hash,
            message: ad.creative.message,
            link: ad.creative.link,
            callToAction: ad.creative.callToAction,
            headline: ad.creative.headline,
            urlTags: ad.urlTags,
            messaging: ad.creative.messaging,
            validateOnly: true,
          };
          try {
            await postCreative({ ...base, features: progress.featuresFallback ? undefined : spec.creativeFeatures });
          } catch (error) {
            if (!progress.featuresFallback && featuresRejected(error)) {
              progress.featuresFallback = true;
              validation.featuresFallback = true;
              try {
                await postCreative({ ...base, features: undefined });
              } catch (retry) {
                validation.issues.push(metaIssue(`ads.${index}.creative`, retry));
              }
            } else {
              validation.issues.push(metaIssue(`ads.${index}.creative`, error));
            }
          }
        }

        // Önizlemeler (ilk reklam): Meta'nın kendi çizimi; hata önizlemeyi
        // düşürür, lansmanı değil.
        const first = spec.ads[0];
        const hash = progress.images?.[0];
        if (first && hash) {
          const creative = {
            object_story_spec: objectStorySpec({
              pageId: spec.pageId,
              instagramUserId: spec.instagramUserId,
              imageHash: hash,
              message: first.creative.message,
              link: first.creative.link,
              callToAction: first.creative.callToAction,
              headline: first.creative.headline,
              messaging: first.creative.messaging,
            }),
            ...(spec.creativeFeatures.send && !progress.featuresFallback
              ? { degrees_of_freedom_spec: creativeFeaturesSpec() }
              : {}),
          };
          for (const format of PREVIEW_FORMATS) {
            try {
              const src = await generatePreview({
                adAccountId,
                accessToken: account.accessToken,
                creative,
                format,
              });
              if (src) validation.previews.push({ format, src });
            } catch {
              // 2606 vb.: kendi önizlememiz gösterilir.
            }
          }
        }
      }

      const status = blockingIssues(validation.issues).length === 0 ? "VALIDATED" : "DRAFT";
      const data = {
        adsAccountId: account.adsAccountRowId ?? null,
        adAccountExternalId: adAccountId,
        spec: spec as unknown as Prisma.InputJsonValue,
        specHash: specHash(spec),
        validation: validation as unknown as Prisma.InputJsonValue,
        progress: progress as Prisma.InputJsonValue,
        status,
      } as const;
      const launch =
        reusable && latest
          ? await prisma.adsLaunch.update({ where: { id: latest.id }, data })
          : await prisma.adsLaunch.create({
              data: {
                ...data,
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                workId: input.workId,
                commandId: input.commandId,
                launchKey: `l${count + 1}`,
                createdByUserId: input.userId,
              },
            });
      return { ok: true as const, launch, validation, spec };
    },
  );
}
