import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import type { GaRange } from "@/lib/website-analytics/analysis/types";
import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import type {
  AttributionMetrics,
  AttributionResult,
} from "@/lib/website-analytics/attribution/types";
import { addDays, dateToDayKey } from "@/lib/website-analytics/days";
import { attributeWindow } from "@/server/website-analytics/attribution/data";
import {
  gaDataThrough,
  primaryGaLink,
} from "@/server/website-analytics/store";

// GA-F6 sonuç okuma API'si (Meta tarafı için, docs/website-attribution.md
// "Meta optimizasyonuna kanıt"): bir Meta kampanyasının sitedeki oturum ve
// key event sayıları. Yalnız kanıt: hiçbir Meta kuralı bunu okumaz. Ambardan
// okur, Google'a çağrı yapmaz; mock bağ için null döner.

export type GaCampaignOutcomes = {
  source: "GA4";
  campaignExternalId: string;
  range: GaRange;
  currency: string | null;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  revenue: number;
  trackedLinks: number;
  days: number;
  coveredDays: number;
};

// Optimizer kararının kanıtına eklenen düz ga4_* alanları. Anahtarların
// hiçbiri "offsite" içermez (decisions.ts olgunluk gecikmesini bu kalıptan
// çıkarır).
export type GaDecisionEvidence = {
  ga4_source: "GA4";
  ga4_from: string;
  ga4_to: string;
  ga4_sessions: number;
  ga4_engaged_sessions: number;
  ga4_key_events: number;
  ga4_covered_days: number;
};

export type GaCampaignEvidenceReader = (
  projectId: string,
  campaignExternalId: string | null,
) => Promise<GaDecisionEvidence | null>;

export const GA_DECISION_EVIDENCE_PREFIX = "ga4_";

const EVIDENCE_DAYS = 7;
const MIN_COVERED_DAYS = 5;

type CampaignAttribution = Awaited<ReturnType<typeof attributeWindow>>;

function usableLink(link: GaPropertyLink | null): GaPropertyLink | null {
  return link && !link.isMock ? link : null;
}

// Kampanyaya eşlenmiş mi: kodlu bağlar ya da eşleşen eski reklam kimlikleri.
function mappedTrackedLinks(
  attribution: CampaignAttribution,
  campaignExternalId: string,
): number {
  const links = attribution.links.filter(
    (link) => link.campaignExternalId === campaignExternalId,
  ).length;
  const group = attribution.result.groups.find(
    (candidate) => candidate.campaignExternalId === campaignExternalId,
  );
  const legacyMatched = attribution.legacy.some(
    (ad) =>
      ad.campaignExternalId === campaignExternalId &&
      (group?.adExternalIds.includes(ad.adExternalId) ?? false),
  );
  return links + (legacyMatched ? 1 : 0);
}

function metricsOf(
  result: AttributionResult,
  campaignExternalId: string,
): AttributionMetrics | null {
  return Object.prototype.hasOwnProperty.call(
    result.byCampaign,
    campaignExternalId,
  )
    ? (result.byCampaign[campaignExternalId] ?? null)
    : null;
}

export async function getGaOutcomesForCampaign(
  projectId: string,
  campaignExternalId: string,
  range: GaRange,
): Promise<GaCampaignOutcomes | null> {
  if (!gaAttributionEnabledFor(projectId) || !campaignExternalId) return null;
  try {
    const link = usableLink(await primaryGaLink(projectId));
    if (!link) return null;
    const attribution = await attributeWindow({
      projectId,
      linkId: link.id,
      range,
    });
    const metrics = metricsOf(attribution.result, campaignExternalId);
    if (!metrics) return null;
    const trackedLinks = mappedTrackedLinks(attribution, campaignExternalId);
    return {
      source: "GA4",
      campaignExternalId,
      range: { from: range.from, to: range.to },
      currency: link.currencyCode ?? null,
      sessions: metrics.sessions,
      engagedSessions: metrics.engagedSessions,
      keyEvents: metrics.keyEvents,
      revenue: metrics.revenue,
      trackedLinks,
      days: attribution.window.days,
      coveredDays: attribution.window.coveredDays,
    };
  } catch {
    return null;
  }
}

type ProjectEvidence = {
  link: GaPropertyLink;
  range: GaRange;
  attribution: Promise<CampaignAttribution>;
};

// Optimizer turu için okuyucu: oluşturulurken sorgu yok; proje başına bağ,
// aralık ve atıf bir kez çözülür, kampanya başına sonuç bellekte tutulur.
// Okuyucu kararın KENDİ projesiyle çağrılır: paylaşılan reklam hesabında A
// projesinin GA sayıları B projesinin kararına girmez.
export function createGaCampaignEvidenceReader(input: {
  now: Date;
}): GaCampaignEvidenceReader {
  const projects = new Map<string, Promise<ProjectEvidence | null>>();
  const results = new Map<string, Promise<GaDecisionEvidence | null>>();
  // Ambarın "bugün"ünden ileri bir gün olamaz.
  const latestAllowed = addDays(dateToDayKey(input.now), 1);

  function resolveProject(projectId: string): Promise<ProjectEvidence | null> {
    const cached = projects.get(projectId);
    if (cached) return cached;
    const pending = (async () => {
      const link = usableLink(await primaryGaLink(projectId));
      if (!link) return null;
      const { through } = await gaDataThrough(link.id);
      if (!through) return null;
      const end = through > latestAllowed ? latestAllowed : through;
      const range = { from: addDays(end, -(EVIDENCE_DAYS - 1)), to: end };
      return {
        link,
        range,
        attribution: attributeWindow({ projectId, linkId: link.id, range }),
      };
    })();
    projects.set(projectId, pending);
    return pending;
  }

  async function read(
    projectId: string,
    campaignExternalId: string,
  ): Promise<GaDecisionEvidence | null> {
    try {
      const project = await resolveProject(projectId);
      if (!project) return null;
      const attribution = await project.attribution;
      if (attribution.window.coveredDays < MIN_COVERED_DAYS) return null;
      const metrics = metricsOf(attribution.result, campaignExternalId);
      if (!metrics) return null;
      return {
        ga4_source: "GA4",
        ga4_from: project.range.from,
        ga4_to: project.range.to,
        ga4_sessions: Math.round(metrics.sessions),
        ga4_engaged_sessions: Math.round(metrics.engagedSessions),
        ga4_key_events: Math.round(metrics.keyEvents * 100) / 100,
        ga4_covered_days: attribution.window.coveredDays,
      };
    } catch {
      return null;
    }
  }

  return async (projectId, campaignExternalId) => {
    if (!campaignExternalId || !gaAttributionEnabledFor(projectId)) {
      return null;
    }
    const key = `${projectId}:${campaignExternalId}`;
    const cached = results.get(key);
    if (cached) return cached;
    const pending = read(projectId, campaignExternalId);
    results.set(key, pending);
    return pending;
  };
}
