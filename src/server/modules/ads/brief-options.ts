import "server-only";

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import {
  defaultAdsCountries,
  type AdsBriefOptions,
} from "@/lib/module-flows/ads/state";

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
  return { account, posts, defaults };
}
