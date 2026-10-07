import { entityKindLabel, type TrackedLinkRef } from "@/lib/tracked-links/types";
import { isAgxCampaign, parseAgxCode } from "@/lib/utm";
import type { GaTableRow } from "@/lib/website-analytics/slices";

import type {
  AttributionGroup,
  AttributionMetrics,
  AttributionResult,
  CampaignSliceRow,
  FromAgentelseRow,
  FromAgentelseView,
  LegacyMetaAd,
} from "./types";

// GA kampanya dilimlerinin Agentelse'in etiketli linklerine bağlanması
// (docs/website-attribution.md "Atıf"). Sıra: agx kodu → eski Meta {{ad.id}}
// → agx kampanyası → "Other tagged links". agx olmayan satırlar yok sayılır.
// Saf modül: Google'a ya da veritabanına gitmez.

// catalog.ts "campaign" v1 ile aynı sıra: GaTableRow.key bu boyutlarla gelir.
export const CAMPAIGN_DIMENSIONS = [
  "sessionCampaignName",
  "sessionSource",
  "sessionMedium",
  "sessionManualAdContent",
] as const;
export const CAMPAIGN_METRICS = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
] as const;

// Eski DEFAULT_URL_TAGS utm_source=meta gönderir; GA kaynağı yine de bu
// adlardan biri olabilir.
export const META_LIKE_SOURCES: readonly string[] = [
  "meta",
  "facebook",
  "fb",
  "instagram",
  "ig",
];

const LEGACY_CANDIDATE_LIMIT = 500;
const DEFAULT_ROW_LIMIT = 10;

// aggregateSlices çıktısı (CAMPAIGN_DIMENSIONS × CAMPAIGN_METRICS) → satırlar.
export function campaignRowsOf(
  table: readonly GaTableRow[],
): CampaignSliceRow[] {
  return table.map((row) => ({
    campaign: row.key[0] ?? "",
    source: row.key[1] ?? "",
    medium: row.key[2] ?? "",
    content: row.key[3] ?? "",
    sessions: row.values[0] ?? 0,
    engagedSessions: row.values[1] ?? 0,
    keyEvents: row.values[2] ?? 0,
    revenue: row.values[3] ?? 0,
  }));
}

function zero(): AttributionMetrics {
  return { sessions: 0, engagedSessions: 0, keyEvents: 0, revenue: 0 };
}

function add(target: AttributionMetrics, row: AttributionMetrics): void {
  target.sessions += row.sessions;
  target.engagedSessions += row.engagedSessions;
  target.keyEvents += row.keyEvents;
  target.revenue += row.revenue;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Etkileşimli oturum yüzdesi (0–100, 1 ondalık); oturum yoksa null.
export function engagementPct(m: AttributionMetrics): number | null {
  return m.sessions > 0 ? round1((m.engagedSessions / m.sessions) * 100) : null;
}

function metaKeyOf(campaignExternalId: string | null, utmCampaign: string) {
  return campaignExternalId
    ? `meta:${campaignExternalId}`
    : `meta:c:${utmCampaign}`;
}

function newGroup(
  key: string,
  base: Pick<
    AttributionGroup,
    "kind" | "entityType" | "channel" | "label" | "campaignExternalId"
  >,
): AttributionGroup {
  return {
    key,
    ...base,
    linkIds: [],
    adExternalIds: [],
    metrics: zero(),
    adMetrics: zero(),
  };
}

function linkLabel(link: TrackedLinkRef): string {
  if (link.entityType === "instagram_bio") return "Instagram bio link";
  return link.label ?? entityKindLabel(link.entityType);
}

export function attributeCampaignRows(
  rows: readonly CampaignSliceRow[],
  links: readonly TrackedLinkRef[],
  legacy: readonly LegacyMetaAd[] = [],
): AttributionResult {
  const groups = new Map<string, AttributionGroup>();
  const groupOfLink = new Map<string, AttributionGroup>();
  const byCode = new Map<string, TrackedLinkRef>();
  const byLink: Record<string, AttributionMetrics> = {};
  // Meta grubunun etiketi: ilk dolu link etiketi (sıra korunur).
  const metaLabelled = new Set<string>();

  for (const link of links) {
    byCode.set(link.code.toLowerCase(), link);
    byLink[link.id] = zero();
    if (link.entityType === "meta_ad") {
      const key = metaKeyOf(link.campaignExternalId, link.utmCampaign);
      let group = groups.get(key);
      if (!group) {
        group = newGroup(key, {
          kind: "meta_campaign",
          entityType: "meta_ad",
          channel: "meta_ads",
          label: "Meta campaign",
          campaignExternalId: link.campaignExternalId,
        });
        groups.set(key, group);
      }
      if (link.label && !metaLabelled.has(key)) {
        group.label = link.label;
        metaLabelled.add(key);
      }
      group.linkIds.push(link.id);
      if (link.carriesCode && link.adExternalId) {
        if (!group.adExternalIds.includes(link.adExternalId)) {
          group.adExternalIds.push(link.adExternalId);
        }
      }
      groupOfLink.set(link.id, group);
    } else {
      const key = `link:${link.id}`;
      const group = newGroup(key, {
        kind: "link",
        entityType: link.entityType,
        channel: link.channel,
        label: linkLabel(link),
        campaignExternalId: null,
      });
      group.linkIds.push(link.id);
      groups.set(key, group);
      groupOfLink.set(link.id, group);
    }
  }

  const legacyByAd = new Map(legacy.map((ad) => [ad.adExternalId, ad]));
  // agx kampanyası → o kampanyayı kullanan projenin grupları.
  const groupsOfCampaign = new Map<string, Set<AttributionGroup>>();
  for (const link of links) {
    const campaign = link.utmCampaign.trim().toLowerCase();
    const group = groupOfLink.get(link.id);
    if (!group) continue;
    const set = groupsOfCampaign.get(campaign) ?? new Set<AttributionGroup>();
    set.add(group);
    groupsOfCampaign.set(campaign, set);
  }

  const unknownAgx = zero();
  let matchedRows = 0;

  for (const row of rows) {
    const code = parseAgxCode(row.content);
    const link = code ? byCode.get(code) : undefined;
    if (link) {
      const group = groupOfLink.get(link.id);
      if (group) {
        add(byLink[link.id]!, row);
        add(group.metrics, row);
        if (link.adExternalId && group.adExternalIds.includes(link.adExternalId)) {
          add(group.adMetrics, row);
        }
        matchedRows += 1;
        continue;
      }
    }

    const legacyAd =
      !code && META_LIKE_SOURCES.includes(row.source.trim().toLowerCase())
        ? legacyByAd.get(row.content.trim())
        : undefined;
    if (legacyAd) {
      const key = `meta:${legacyAd.campaignExternalId}`;
      let group = groups.get(key);
      if (!group) {
        group = newGroup(key, {
          kind: "meta_campaign",
          entityType: "meta_ad",
          channel: "meta_ads",
          label: legacyAd.label || "Meta campaign",
          campaignExternalId: legacyAd.campaignExternalId,
        });
        groups.set(key, group);
      }
      if (!group.adExternalIds.includes(legacyAd.adExternalId)) {
        group.adExternalIds.push(legacyAd.adExternalId);
      }
      add(group.metrics, row);
      add(group.adMetrics, row);
      matchedRows += 1;
      continue;
    }

    if (isAgxCampaign(row.campaign)) {
      const candidates = groupsOfCampaign.get(row.campaign.trim().toLowerCase());
      if (candidates?.size === 1) {
        const [group] = [...candidates];
        add(group!.metrics, row);
        matchedRows += 1;
      } else {
        add(unknownAgx, row);
      }
      continue;
    }

    // Kodu agx'e benzeyen ama projeye ait olmayan satır başka projenin ya da
    // silinmiş bir linkin ziyaretidir.
    if (code) add(unknownAgx, row);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      b.metrics.sessions - a.metrics.sessions || a.key.localeCompare(b.key),
  );
  const total = zero();
  const byCampaign: Record<string, AttributionMetrics> = {};
  for (const group of ordered) {
    add(total, group.metrics);
    if (group.kind === "meta_campaign" && group.campaignExternalId) {
      byCampaign[group.campaignExternalId] = group.metrics;
    }
  }
  add(total, unknownAgx);

  return { groups: ordered, byLink, byCampaign, unknownAgx, total, matchedRows };
}

// "From Agentelse" tablosu: ilk `limit` grup satır olur; kalanlar ve tanınmayan
// agx satırları "other"a toplanır (boşsa null).
export function fromAgentelseRows(
  result: AttributionResult,
  limit: number = DEFAULT_ROW_LIMIT,
): { rows: FromAgentelseRow[]; other: FromAgentelseView["other"] } {
  const shown = result.groups.slice(0, Math.max(0, limit));
  const rest = result.groups.slice(shown.length);
  const rows = shown.map((group) => ({
    key: group.key,
    label: group.label,
    kindLabel: entityKindLabel(group.entityType),
    channel: group.channel,
    sessions: group.metrics.sessions,
    engagementRate: engagementPct(group.metrics),
    keyEvents: group.metrics.keyEvents,
    revenue: round2(group.metrics.revenue),
  }));
  const other = zero();
  for (const group of rest) add(other, group.metrics);
  add(other, result.unknownAgx);
  const empty =
    rest.length === 0 &&
    other.sessions === 0 &&
    other.keyEvents === 0 &&
    other.revenue === 0;
  return {
    rows,
    other: empty
      ? null
      : {
          sessions: other.sessions,
          engagementRate: engagementPct(other),
          keyEvents: other.keyEvents,
          revenue: round2(other.revenue),
        },
  };
}

// Eski {{ad.id}} adayları: Meta benzeri kaynakta, yalnız rakamlardan oluşan
// içerik değerleri (benzersiz, en çok 500).
export function legacyAdCandidates(rows: readonly CampaignSliceRow[]): string[] {
  const found = new Set<string>();
  for (const row of rows) {
    if (found.size >= LEGACY_CANDIDATE_LIMIT) break;
    const content = row.content.trim();
    if (
      /^\d{6,}$/.test(content) &&
      META_LIKE_SOURCES.includes(row.source.trim().toLowerCase())
    ) {
      found.add(content);
    }
  }
  return [...found];
}
