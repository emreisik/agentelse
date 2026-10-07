import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { recipeReady, recommendedGoal } from "@/lib/ads/objectives";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import {
  defaultAdsCountries,
  type AdsBriefOptions,
} from "@/lib/module-flows/ads/state";

import { adsAccountAssets } from "@/server/ads/account-assets";

import { loadAdsAccount } from "./account";
import { listSourcePosts } from "./source-posts";

// Everything the Ads Manager Brief needs to draw itself: the Meta Ads
// connection, the posts an ad can be made from, and the project's own defaults
// (its website, its markets). Read-only.

async function projectDefaults(
  projectId: string,
): Promise<AdsBriefOptions["defaults"]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true, country: true, countries: true },
  });
  if (!project) return { countries: [] };
  const domain = project.domain ? normalizeDomain(project.domain) : "";
  return {
    ...(domain && isValidDomain(domain) ? { link: `https://${domain}` } : {}),
    countries: defaultAdsCountries(project.countries ?? [], project.country),
  };
}

export async function loadAdsBriefOptions(
  projectId: string,
  options: { include?: string } = {},
): Promise<AdsBriefOptions> {
  const [account, posts, defaults] = await Promise.all([
    loadAdsAccount(projectId),
    listSourcePosts(projectId, options),
    projectDefaults(projectId),
  ]);
  // F5a (META_ADS_PLANNER, güvenli lansman v2 ile): mesaj hedefi ve açılış
  // sayfası görüntüleme. Instagram Direct yalnız reklam hesabının bir IG
  // kimliği varken; LPV yalnız son 7 günde olay gönderen piksel varken.
  if (!AdsFlags.planner() || !AdsFlags.launchV2() || account.status !== "ready") {
    return { account, posts, defaults };
  }
  const assets = await adsAccountAssets(projectId).catch(() => null);
  // Video reklam (META_ADS_VIDEO): projenin Library videoları.
  const videos = AdsFlags.video()
    ? (
        await prisma.asset.findMany({
          where: { projectId, mimeType: { startsWith: "video/" } },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: { id: true, filename: true },
        })
      ).map((row) => ({ assetId: row.id, name: row.filename.slice(0, 80) }))
    : [];
  // Reklam eklenebilen açık ad set'ler (ayna senkronlandıysa).
  const mirror = await AdsMirror.accountFor(projectId).catch(() => null);
  const [adSetRows, campaignRows] = mirror
    ? await Promise.all([
        AdsMirror.objects(mirror, "ADSET"),
        AdsMirror.objects(mirror, "CAMPAIGN"),
      ])
    : [[], []];
  const campaignName = new Map(campaignRows.map((row) => [row.externalId, row.name]));
  const now = Date.now();
  const adSets = adSetRows
    .filter(
      (row) =>
        row.configuredStatus === "ACTIVE" &&
        (!row.endTime || row.endTime.getTime() > now),
    )
    .slice(0, 20)
    .map((row) => ({
      id: row.externalId,
      name: nameWithoutTag(row.name),
      campaignName: nameWithoutTag(campaignName.get(row.campaignExternalId ?? "") ?? ""),
    }));
  return {
    account,
    posts,
    defaults,
    leads: recipeReady("leads_instant_form"),
    recommended: recommendedGoal({
      hasPixel: Boolean(assets?.hasPixel),
      messagesOffered: true,
    }),
    ...(adSets.length > 0 ? { adSets } : {}),
    ...(videos.length > 0 ? { videos } : {}),
    goals: {
      messages: true,
      messageApps: [
        "WHATSAPP",
        "MESSENGER",
        ...(assets?.instagramUserId ? (["INSTAGRAM_DIRECT"] as const) : []),
      ],
      landingPageViews: Boolean(assets?.hasPixel),
      instagramProfile:
        recipeReady("traffic_instagram_profile") &&
        Boolean(assets?.instagramUserId && assets.instagramUsername),
    },
    hasPixel: Boolean(assets?.hasPixel),
  };
}
