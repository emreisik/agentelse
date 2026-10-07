import "server-only";

import { INSTAGRAM_BIO_ENTITY_ID } from "@/lib/tracked-links/types";
import { AGX_BIO_CAMPAIGN, isOwnSiteUrl, stripUtm } from "@/lib/utm";

import { projectSiteDomains } from "./domains";
import { utmTaggingOnFor } from "./settings";
import { ensureTrackedLink, findTrackedLink } from "./store";

const LINK_MAX = 2048;
const BIO_LABEL = "Instagram bio link";

export type BioLinkView = {
  url: string;
  destinationUrl: string;
  code: string;
  updatedAt: string;
};

export type SaveBioLinkResult =
  | { ok: true; link: BioLinkView }
  | { ok: false; reason: "off" | "invalid" | "no_domain" | "not_own_site" };

function viewOf(record: {
  taggedUrl: string;
  destinationUrl: string;
  code: string;
  updatedAt: string;
}): BioLinkView {
  return {
    url: record.taggedUrl,
    destinationUrl: record.destinationUrl,
    code: record.code,
    updatedAt: record.updatedAt,
  };
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > LINK_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function loadInstagramBioLink(
  projectId: string,
): Promise<BioLinkView | null> {
  const record = await findTrackedLink(
    projectId,
    "instagram_bio",
    INSTAGRAM_BIO_ENTITY_ID,
  );
  return record ? viewOf(record) : null;
}

// Instagram bio linki: projenin kendi sitesindeki bir sayfa + agx-bio UTM'leri.
// Hedefteki mevcut utm_* silinir; bio linki daima kendi kodunu taşır.
export async function saveInstagramBioLink(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  destinationUrl: string;
}): Promise<SaveBioLinkResult> {
  if (!(await utmTaggingOnFor(input.projectId))) {
    return { ok: false, reason: "off" };
  }
  const raw = input.destinationUrl.trim();
  if (!isHttpUrl(raw)) return { ok: false, reason: "invalid" };

  const destinationUrl = stripUtm(raw);
  const domains = await projectSiteDomains(input.projectId);
  if (domains.length === 0) return { ok: false, reason: "no_domain" };
  if (!isOwnSiteUrl(destinationUrl, domains)) {
    return { ok: false, reason: "not_own_site" };
  }

  const record = await ensureTrackedLink({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    entityType: "instagram_bio",
    entityId: INSTAGRAM_BIO_ENTITY_ID,
    channel: "instagram",
    destinationUrl,
    campaign: AGX_BIO_CAMPAIGN,
    label: BIO_LABEL,
    userId: input.userId,
  });
  return { ok: true, link: viewOf(record) };
}
