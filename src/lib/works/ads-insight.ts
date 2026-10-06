import {
  THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
} from "@/lib/ads/money";
import { copyText } from "@/lib/works/copy";

// The Meta Ads card's data (spec 3.12.2). Pure and isomorphic: the server reads
// the credential metadata and the pending spend tasks, this decides the five
// honest states and the texts. The card is live and never stored; no LLM.
// Honesty rules: "CPL" only when the result is Leads; "vs last check" is scan
// to scan; an amount is printed ONLY when the currency is known and has cents.

export type AdsChip = {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
};

export type AdsProposalCapability =
  "META_CAMPAIGN_UPDATE" | "META_ADSET_UPDATE";

export type AdsInsightCardData = {
  kind: "ads-insight";
  state:
    | "ok"
    | "needs-connect"
    | "needs-account"
    | "no-data"
    | "nothing"
    | "stale"
    | "error";
  asOf?: string;
  currency?: string;
  headline?: string;
  campaignId?: string;
  campaignName?: string;
  chips: AdsChip[];
  proposal?: {
    taskId: string;
    approvalId: string;
    capability: AdsProposalCapability;
    currentDailyBudgetCents?: number;
    proposedDailyBudgetCents?: number;
    proposedStatus?: string;
    // 'changed': the live budget moved since the proposal; only Dismiss is
    // offered (the proposal is an absolute budget applied as is).
    state: "pending" | "changed";
    changeText: string;
  };
  // Further pending proposals the card does not show.
  more?: number;
  // F2: açık CRITICAL/WARN uyarılar ve "Pause all" (çalışan kampanya varsa).
  alerts?: AdsPulseAlert[];
  pauseAll?: { campaigns: number };
};

export type AdsDigestCampaign = {
  id: string;
  name: string;
  dailyBudgetCents: number;
  spend: number;
  resultLabel?: string;
  resultCount?: number;
  costPerResult?: number;
  prevCostPerResult?: number;
  costChangePct?: number;
  ctr?: number;
};

export type AdsDigest = {
  at: string;
  currency: string;
  campaigns: AdsDigestCampaign[];
  // The ad account the numbers were read from, stamped by the writers. A
  // digest of another account than the selected one is never shown.
  adAccountId?: string;
};

export const MAX_DIGEST_CAMPAIGNS = 5;
// The scanner runs about every 7 h: older than this means a scan was missed.
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

// Meta budgets are minor units. Zero-decimal currencies have no cents and
// three-decimal ones a thousandth, so cents / 100 would be a 10x to 100x
// error: never printed here. The lists live in src/lib/ads/money.ts (the one
// money module, docs/meta-ads-plan.md F0b).
export {
  THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
} from "@/lib/ads/money";
function currencyCode(currency: string | undefined): string | null {
  const code = currency?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

// An amount of minor units is printed ONLY when the currency is known and has
// two decimals (the proposal payload carries no currency of its own).
export function canShowAmount(currency?: string): boolean {
  const code = currencyCode(currency);
  if (!code) return false;
  return (
    !ZERO_DECIMAL_CURRENCIES.includes(code) &&
    !THREE_DECIMAL_CURRENCIES.includes(code)
  );
}

// "400 TRY", "38.20 TRY": whole amounts lose the decimals.
function formatMajor(value: number, code: string): string {
  const whole = Number.isInteger(value);
  const number = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${number} ${code}`;
}

export function formatMinorUnits(
  cents: number,
  currency?: string,
): string | null {
  if (!canShowAmount(currency) || !Number.isFinite(cents)) return null;
  return formatMajor(cents / 100, currencyCode(currency)!);
}

// A cost per result is in MAJOR units (Meta insights), so zero-decimal
// currencies are fine; an unknown currency still prints nothing.
function formatCost(cost: number, currency?: string): string | null {
  const code = currencyCode(currency);
  if (!code || !Number.isFinite(cost) || cost < 0) return null;
  return formatMajor(cost, code);
}

// CPL only when the result IS Leads: costPerResult is cost per the action with
// the highest count, often engagement for a lead campaign.
export function chipLabelFor(resultLabel?: string): string {
  const label = resultLabel?.trim();
  if (label === "Leads") return copyText("ads.chip.cpl");
  return copyText("ads.chip.costPer", { label: label || "result" });
}

// A pause proposal (zero results with spend) carries a status and no budget:
// it must never read as a budget change.
export function isPauseProposal(proposal: {
  proposedStatus?: string;
  proposedDailyBudgetCents?: number;
}): boolean {
  return (
    proposal.proposedStatus === "PAUSED" &&
    typeof proposal.proposedDailyBudgetCents !== "number"
  );
}

export function proposalChangeText(
  current?: number,
  proposed?: number,
  currency?: string,
  proposedStatus?: string,
): string {
  if (isPauseProposal({ proposedStatus, proposedDailyBudgetCents: proposed })) {
    return copyText("ads.pause");
  }
  if (
    typeof current === "number" &&
    typeof proposed === "number" &&
    current !== proposed
  ) {
    const from = formatMinorUnits(current, currency);
    const to = formatMinorUnits(proposed, currency);
    if (from && to) {
      return copyText(proposed > current ? "ads.raise" : "ads.lower", {
        from,
        to,
      });
    }
  }
  return copyText("ads.change");
}

// ---------------------------------------------------------------------------
// Digest (what the scanner and the click-triggered read store)
// ---------------------------------------------------------------------------

type InsightLike = {
  spend?: number;
  ctr?: number;
  resultLabel?: string;
  resultCount?: number;
  costPerResult?: number;
};
type CampaignLike = {
  campaignId: string;
  name: string;
  effectiveStatus?: string;
  dailyBudgetCents?: number;
};
type SnapshotLike = { costPerResult?: number; resultLabel?: string };

const SNAPSHOT_PREFIX = "meta-campaign:";

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function insightOf(
  insights:
    ReadonlyMap<string, InsightLike> | Readonly<Record<string, InsightLike>>,
  id: string,
): InsightLike | undefined {
  return insights instanceof Map
    ? insights.get(id)
    : (insights as Readonly<Record<string, InsightLike>>)[id];
}

// Top campaigns by spend; ACTIVE with spend and a daily budget only (the same
// rule as the scanner). Never throws: a bad input yields an empty digest.
export function buildAdsDigest({
  insights,
  previousSnapshot,
  campaigns,
  currency,
  now,
}: {
  insights:
    ReadonlyMap<string, InsightLike> | Readonly<Record<string, InsightLike>>;
  previousSnapshot?: Readonly<Record<string, SnapshotLike>> | null;
  campaigns: readonly CampaignLike[];
  currency: string;
  now: Date;
}): AdsDigest {
  const at = Number.isNaN(now.getTime())
    ? new Date().toISOString()
    : now.toISOString();
  const empty: AdsDigest = { at, currency, campaigns: [] };
  try {
    const rows: AdsDigestCampaign[] = [];
    for (const campaign of campaigns) {
      if (campaign.effectiveStatus && campaign.effectiveStatus !== "ACTIVE") {
        continue;
      }
      const insight = insightOf(insights, campaign.campaignId);
      if (!insight || !positive(insight.spend)) continue;
      if (!positive(campaign.dailyBudgetCents)) continue;

      const cost = positive(insight.costPerResult)
        ? insight.costPerResult
        : undefined;
      const previousRow =
        previousSnapshot?.[`${SNAPSHOT_PREFIX}${campaign.campaignId}`];
      const prevRaw = previousRow?.costPerResult;
      // A cost per Leads is never compared with a cost per Link Clicks: when
      // both rows name their result and the names differ, there is no baseline.
      const sameResult =
        !previousRow?.resultLabel ||
        !insight.resultLabel ||
        previousRow.resultLabel === insight.resultLabel;
      const prev = positive(prevRaw) && sameResult ? prevRaw : undefined;
      rows.push({
        id: campaign.campaignId,
        name: campaign.name,
        dailyBudgetCents: campaign.dailyBudgetCents,
        spend: insight.spend,
        ...(insight.resultLabel ? { resultLabel: insight.resultLabel } : {}),
        ...(finiteOrUndefined(insight.resultCount) !== undefined
          ? { resultCount: insight.resultCount }
          : {}),
        ...(cost !== undefined ? { costPerResult: cost } : {}),
        ...(prev !== undefined ? { prevCostPerResult: prev } : {}),
        ...(cost !== undefined && prev !== undefined
          ? { costChangePct: Math.round(((cost - prev) / prev) * 1000) / 10 }
          : {}),
        ...(finiteOrUndefined(insight.ctr) !== undefined
          ? { ctr: insight.ctr }
          : {}),
      });
    }
    rows.sort((a, b) => b.spend - a.spend);
    return { at, currency, campaigns: rows.slice(0, MAX_DIGEST_CAMPAIGNS) };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Pulse -> card
// ---------------------------------------------------------------------------

export type AdsPulseProposal = {
  taskId: string;
  approvalId: string;
  capability: AdsProposalCapability;
  campaignId?: string;
  campaignName?: string;
  currentDailyBudgetCents?: number;
  proposedDailyBudgetCents?: number;
  proposedStatus?: string;
  reason?: string;
};

export type AdsPulseAlert = {
  id: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  title: string;
};

export type AdsPulse = {
  connected: boolean;
  hasAccount: boolean;
  digest?: AdsDigest | null;
  lastScanAt?: string;
  failureCount?: number;
  proposals: AdsPulseProposal[];
  // F2 (ayna): açık uyarılar, çalışan kampanya sayısı ve bayatlık eşiği.
  alerts?: AdsPulseAlert[];
  runningCampaigns?: number;
  staleAfterMs?: number;
};

function dateText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function pctText(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function proposalOf(
  pulse: AdsPulse,
  currency: string | undefined,
  // The proposal's OWN campaign when the digest holds it. The digest keeps the
  // top 5 by spend while the scanner proposes for up to 30, so a proposal may
  // be about a campaign the digest does not carry: then nothing is compared.
  own: AdsDigestCampaign | undefined,
): Pick<AdsInsightCardData, "proposal" | "more"> {
  const [first] = pulse.proposals;
  if (!first) return {};
  const current = first.currentDailyBudgetCents;
  // The proposal is an absolute budget: when the live budget moved, applying
  // it as is would be wrong, so only Dismiss is offered.
  const changed =
    own !== undefined &&
    typeof current === "number" &&
    current !== own.dailyBudgetCents;
  const base = {
    taskId: first.taskId,
    approvalId: first.approvalId,
    capability: first.capability,
    ...(first.proposedStatus ? { proposedStatus: first.proposedStatus } : {}),
  };
  const more = pulse.proposals.length - 1;
  return {
    proposal: changed
      ? { ...base, state: "changed", changeText: copyText("ads.changed") }
      : {
          ...base,
          ...(typeof current === "number"
            ? { currentDailyBudgetCents: current }
            : {}),
          ...(typeof first.proposedDailyBudgetCents === "number"
            ? { proposedDailyBudgetCents: first.proposedDailyBudgetCents }
            : {}),
          state: "pending",
          changeText: proposalChangeText(
            current,
            first.proposedDailyBudgetCents,
            currency,
            first.proposedStatus,
          ),
        },
    ...(more > 0 ? { more } : {}),
  };
}

export function buildAdsInsight(
  pulse: AdsPulse,
  now: Date,
): AdsInsightCardData {
  if (!pulse.connected) {
    return {
      kind: "ads-insight",
      state: "needs-connect",
      headline: copyText("ads.state.needsConnect"),
      chips: [],
    };
  }
  if (!pulse.hasAccount) {
    return {
      kind: "ads-insight",
      state: "needs-account",
      headline: copyText("ads.state.needsAccount"),
      chips: [],
    };
  }

  const digest = pulse.digest ?? null;
  if (!digest) {
    // Never scanned, or scanned before digests existed: nothing to show yet.
    return {
      kind: "ads-insight",
      state: "no-data",
      headline: copyText("ads.state.noData"),
      chips: [],
      ...proposalOf(pulse, undefined, undefined),
    };
  }

  const currency = digest.currency || undefined;
  const age = now.getTime() - new Date(digest.at).getTime();
  // An unreadable timestamp counts as stale: never claim fresh numbers.
  const stale =
    !Number.isFinite(age) ||
    age > (pulse.staleAfterMs ?? STALE_AFTER_MS) ||
    (pulse.failureCount ?? 0) > 0;

  // The campaign a pending proposal is about wins the headline.
  const proposed = pulse.proposals[0];
  const own = proposed?.campaignId
    ? digest.campaigns.find((c) => c.id === proposed.campaignId)
    : undefined;
  const focus = own ?? digest.campaigns[0];
  const proposalPart = proposalOf(pulse, currency, own);

  const chips: AdsChip[] = [];
  let headline: string | undefined;
  if (focus) {
    const cost =
      focus.costPerResult !== undefined
        ? formatCost(focus.costPerResult, currency)
        : null;
    if (cost) {
      chips.push({ label: chipLabelFor(focus.resultLabel), value: cost });
      headline = copyText("ads.headline", {
        campaign: focus.name,
        label: focus.resultLabel?.trim() || "result",
        cost,
      });
    }
    if (focus.costChangePct !== undefined) {
      chips.push({
        label: copyText("ads.chip.change", {
          pct: pctText(focus.costChangePct),
        }),
        value: pctText(focus.costChangePct),
        tone:
          focus.costChangePct > 0
            ? "bad"
            : focus.costChangePct < 0
              ? "good"
              : "neutral",
      });
    }
  }
  const proposal = proposalPart.proposal;
  if (
    proposal?.state === "pending" &&
    typeof proposal.proposedDailyBudgetCents === "number"
  ) {
    const amount = formatMinorUnits(
      proposal.proposedDailyBudgetCents,
      currency,
    );
    if (amount) {
      chips.push({
        label: copyText("ads.chip.suggested", { amount }),
        value: amount,
        tone: "neutral",
      });
    }
  }

  const common = {
    kind: "ads-insight" as const,
    asOf: digest.at,
    ...(currency ? { currency } : {}),
    ...(focus ? { campaignId: focus.id, campaignName: focus.name } : {}),
    chips,
    ...proposalPart,
    ...(pulse.alerts && pulse.alerts.length > 0 ? { alerts: pulse.alerts } : {}),
    ...(pulse.runningCampaigns
      ? { pauseAll: { campaigns: pulse.runningCampaigns } }
      : {}),
  };

  if (stale) {
    return {
      ...common,
      state: "stale",
      headline: copyText("ads.state.stale", { date: dateText(digest.at) }),
    };
  }
  if (digest.campaigns.length === 0) {
    return {
      ...common,
      state: "nothing",
      headline: copyText("ads.state.nothing"),
    };
  }
  return {
    ...common,
    state: "ok",
    // Without a usable currency the cost is not printed: the campaign name
    // alone stands in for the headline.
    headline: headline ?? focus?.name,
  };
}

// One isomorphic builder for the ads page links (new campaign form, read-only
// campaign sheet).
export function adsHref(
  projectId: string,
  options: { create?: boolean; brief?: string; campaignDetail?: string } = {},
): string {
  const params = new URLSearchParams();
  if (options.create) params.set("create", "campaign");
  if (options.brief) params.set("brief", options.brief);
  if (options.campaignDetail) {
    params.set("campaignDetail", options.campaignDetail);
  }
  const query = params.toString();
  return `/projects/${projectId}/ads${query ? `?${query}` : ""}`;
}
