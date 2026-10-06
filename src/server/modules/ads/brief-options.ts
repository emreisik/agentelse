import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
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
  return {
    account,
    posts,
    defaults,
    goals: {
      messages: true,
      messageApps: [
        "WHATSAPP",
        "MESSENGER",
        ...(assets?.instagramUserId ? (["INSTAGRAM_DIRECT"] as const) : []),
      ],
      landingPageViews: Boolean(assets?.hasPixel),
    },
    hasPixel: Boolean(assets?.hasPixel),
  };
}
