import { SOURCE_LABEL } from "./catalog";
import {
  formatCount,
  formatMoney,
  formatPercent,
  formatPosition,
} from "./format";
import {
  isSnapshotMetric,
  metricLabel,
  metricText,
  okSections,
  periodText,
  type OkSection,
  type ReportData,
} from "./report";

// The ONLY thing the AI summary is given (docs/modules.md "Analytics"): the
// report's numbers, written exactly as the report shows them, with their
// labels and periods. No project, brand, account or person, and nothing about
// the sources that failed: the model can only talk about what the person sees.
// Pure.

export type SummaryFactsSection = {
  source: string;
  period: string;
  metrics: { name: string; value: string }[];
  results?: { type: string; count: string; costPerResult?: string }[];
  topCampaigns?: {
    name: string;
    spend: string;
    results?: string;
    costPerResult?: string;
  }[];
  topSearches?: {
    query: string;
    clicks: string;
    impressions: string;
    ctr: string;
    position: string;
  }[];
  // Google Analytics lists (warehouse only); shares and rates as shown.
  topChannels?: {
    channel: string;
    sessions: string;
    share?: string;
    engagementRate?: string;
    keyEvents: string;
  }[];
  topLandingPages?: {
    page: string;
    sessions: string;
    engagementRate?: string;
    keyEvents: string;
  }[];
  keyEvents?: { name: string; count: string }[];
};

export type SummaryFacts = {
  period: string;
  sections: SummaryFactsSection[];
};

function sectionFacts(section: OkSection): SummaryFactsSection {
  const money = (value: number) => formatMoney(value, section.currency);
  const facts: SummaryFactsSection = {
    source: SOURCE_LABEL[section.source],
    period: periodText(section.days),
    metrics: section.metrics.map((metric) => ({
      name: isSnapshotMetric(metric.key)
        ? `${metricLabel(metric.key)} (now)`
        : metricLabel(metric.key),
      value: metricText(metric, section.currency),
    })),
  };
  if (section.results.length > 0) {
    facts.results = section.results.map((result) => ({
      type: result.label,
      count: formatCount(result.count),
      ...(result.costPerResult !== null
        ? { costPerResult: money(result.costPerResult) }
        : {}),
    }));
  }
  if (section.campaigns.length > 0) {
    facts.topCampaigns = section.campaigns.map((campaign) => ({
      name: campaign.name,
      spend: money(campaign.spend),
      ...(campaign.results !== null && campaign.resultLabel
        ? {
            results: `${formatCount(campaign.results)} ${campaign.resultLabel}`,
          }
        : {}),
      ...(campaign.costPerResult !== null
        ? { costPerResult: money(campaign.costPerResult) }
        : {}),
    }));
  }
  if (section.queries.length > 0) {
    facts.topSearches = section.queries.map((query) => ({
      query: query.query,
      clicks: formatCount(query.clicks),
      impressions: formatCount(query.impressions),
      ctr: formatPercent(query.ctr),
      position: formatPosition(query.position),
    }));
  }
  const channels = section.channels ?? [];
  if (channels.length > 0) {
    facts.topChannels = channels.map((channel) => ({
      channel: channel.channel,
      sessions: formatCount(channel.sessions),
      ...(channel.share !== null ? { share: formatPercent(channel.share) } : {}),
      ...(channel.engagementRate !== null
        ? { engagementRate: formatPercent(channel.engagementRate) }
        : {}),
      keyEvents: formatCount(channel.keyEvents),
    }));
  }
  const landingPages = section.landingPages ?? [];
  if (landingPages.length > 0) {
    facts.topLandingPages = landingPages.map((page) => ({
      page: page.page,
      sessions: formatCount(page.sessions),
      ...(page.engagementRate !== null
        ? { engagementRate: formatPercent(page.engagementRate) }
        : {}),
      keyEvents: formatCount(page.keyEvents),
    }));
  }
  const keyEvents = section.keyEvents ?? [];
  if (keyEvents.length > 0) {
    facts.keyEvents = keyEvents.map((event) => ({
      name: event.name,
      count: formatCount(event.count),
    }));
  }
  return facts;
}

export function summaryFactsOf(report: ReportData): SummaryFacts {
  return {
    period: periodText(report.period),
    sections: okSections(report)
      .filter((section) => section.metrics.length > 0)
      .map(sectionFacts),
  };
}
