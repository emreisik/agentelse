import type { TrackedEntityType } from "@/lib/tracked-links/types";
import type { GaRange } from "@/lib/website-analytics/analysis/types";
import type { UtmChannel } from "@/lib/utm";

// GA-F6 atıf tipleri (docs/website-attribution.md "Atıf" ve "Reklam ölçümü").
// Hepsi okuma anında hesaplanır; Google verisi için yeni tablo yoktur.
// Saf ve izomorfik modül.

export type AttributionMetrics = {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  // Ana birim, GA mülkünün para birimi.
  revenue: number;
};

// GA "campaign" raporunun bir satırı (kampanya × kaynak × ortam × içerik).
export type CampaignSliceRow = {
  campaign: string;
  source: string;
  medium: string;
  content: string;
} & AttributionMetrics;

// utm_content'i {{ad.id}} olan eski Meta reklamı (DEFAULT_URL_TAGS).
export type LegacyMetaAd = {
  adExternalId: string;
  campaignExternalId: string;
  label: string;
};

export type AttributionGroupKind = "meta_campaign" | "link";

export type AttributionGroup = {
  // "meta:<campaignExternalId>" | "meta:c:<utmCampaign>" | "link:<trackedLinkId>"
  key: string;
  kind: AttributionGroupKind;
  entityType: TrackedEntityType;
  channel: UtmChannel;
  label: string;
  campaignExternalId: string | null;
  linkIds: string[];
  // meta_campaign: carriesCode taşıyan linklerin çözülmüş adExternalId'leri +
  // eşleşen eski reklam kimlikleri; link grubunda [].
  adExternalIds: string[];
  // Kredilenen bütün satırlar.
  metrics: AttributionMetrics;
  // Yalnız koda (adExternalIds'teki bir linke) ya da eski reklam kimliğine
  // göre eşleşen satırlar; Meta AD düzeyiyle aynı reklamları karşılaştırır.
  adMetrics: AttributionMetrics;
};

export type AttributionResult = {
  // Oturum azalan, sonra anahtar.
  groups: AttributionGroup[];
  byLink: Record<string, AttributionMetrics>;
  // campaignExternalId → grup metrikleri.
  byCampaign: Record<string, AttributionMetrics>;
  unknownAgx: AttributionMetrics;
  // groups + unknownAgx.
  total: AttributionMetrics;
  matchedRows: number;
};

export type FromAgentelseRow = {
  key: string;
  label: string;
  kindLabel: string;
  channel: UtmChannel;
  sessions: number;
  // Yüzde 0–100, 1 ondalık.
  engagementRate: number | null;
  keyEvents: number;
  revenue: number;
};

export type FromAgentelseView = {
  range: GaRange;
  currency: string | null;
  // En çok 10.
  rows: FromAgentelseRow[];
  other: {
    sessions: number;
    engagementRate: number | null;
    keyEvents: number;
    revenue: number;
  } | null;
  total: {
    sessions: number;
    engagementRate: number | null;
    keyEvents: number;
    revenue: number;
  };
  // Agentelse etiketli ziyaretlerin sitenin bütün oturumlarındaki payı (1 ondalık).
  sitePct: number | null;
  trackedLinks: number;
  days: number;
  coveredDays: number;
  truncated: boolean;
  notes: string[];
};

export type CrossCheckFlag = "click_loss" | "results_gap";

export type MetaAdsWindow = {
  groupKey: string;
  // En az bir içgörü satırı olan reklam sayısı.
  ads: number;
  // Ana birim, Meta para birimi; birden çok para birimi karışırsa null.
  spend: number | null;
  linkClicks: number;
  landingPageViews: number;
  results: number | null;
  resultActionType: string | null;
  // Harcaması > 0 olan farklı gün sayısı.
  activeDays: number;
};

export type MetaVsGaRow = {
  groupKey: string;
  campaignExternalId: string | null;
  label: string;
  // adExternalIds boş değil ve bir Meta penceresi var.
  tracked: boolean;
  spend: number | null;
  linkClicks: number | null;
  // tracked ise adMetrics, değilse metrics.
  sessions: number;
  clickToSessionPct: number | null;
  results: number | null;
  resultLabel: string | null;
  websiteResults: boolean;
  keyEvents: number;
  costPerResult: number | null;
  // Meta para biriminde.
  costPerKeyEvent: number | null;
  // tracked değilse [].
  flags: CrossCheckFlag[];
};

// GA para biriminde; kampanya adı ham (yalnız projenin kendi kullanıcılarına).
export type GoogleAdsCampaignRow = {
  campaign: string;
  cost: number;
  clicks: number;
  sessions: number;
  keyEvents: number;
  revenue: number;
};

export type GoogleAdsViewRow = GoogleAdsCampaignRow & {
  roas: number | null;
  costPerKeyEvent: number | null;
  previousRoas: number | null;
  previousCostPerKeyEvent: number | null;
};

export type AdsOnWebsiteView = {
  range: GaRange;
  meta: {
    currency: string | null;
    gaCurrency: string | null;
    synced: boolean;
    // En çok 10; harcama azalan (null sonda), sonra oturum.
    rows: MetaVsGaRow[];
    notes: string[];
  } | null;
  googleAds: {
    currency: string | null;
    // En çok 10; maliyet azalan.
    rows: GoogleAdsViewRow[];
    notes: string[];
  } | null;
};

export type WebsiteAttributionView = {
  from: FromAgentelseView | null;
  ads: AdsOnWebsiteView | null;
};

export type AdsCrossCheckCampaign = {
  groupKey: string;
  campaignExternalId: string;
  label: string;
  meta: MetaAdsWindow;
  // group.adMetrics
  ga: AttributionMetrics;
};

export type GaAdsCrossCheckInput = {
  window: GaRange;
  previousWindow: GaRange;
  metaCurrency: string | null;
  campaigns: AdsCrossCheckCampaign[];
  googleAds: {
    current: GoogleAdsCampaignRow[];
    previous: GoogleAdsCampaignRow[];
  } | null;
};

// AN13 eşikleri (docs/website-attribution.md "AN13 / AN14").
export const CROSS_CHECK = {
  minClicks: 100,
  minActiveDays: 7,
  maxClickLoss: 0.4,
  maxResultsGap: 0.3,
  minConversions: 10,
} as const;
