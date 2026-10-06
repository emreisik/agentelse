import { nameWithoutTag } from "./operation-tag";

// Koruma kuralları (docs/meta-ads-plan.md §6 G1, G5, G8). Saf: bekçi
// (src/server/ads/guard/watchdogs.ts) aynadan okuduğunu buraya verir.

export const RUNAWAY_DAILY_FACTOR = 2;
// Meta haftalık en çok 7 × günlük bütçe harcar; %5 pay.
export const RUNAWAY_WEEKLY_FACTOR = 7 * 1.05;
export const REVIEW_SLOW_MS = 24 * 60 * 60_000;
export const NO_DELIVERY_AFTER_MS = 24 * 60 * 60_000;

export type GuardFinding = {
  kind:
    | "RUNAWAY_SPEND"
    | "AD_DISAPPROVED"
    | "ALL_ADS_REJECTED"
    | "DELIVERY_ISSUE"
    | "BILLING_HOLD"
    | "REVIEW_SLOW"
    | "NO_DELIVERY"
    // G2 (F7): onaylı zarf doldu.
    | "ENVELOPE_REACHED";
  severity: "INFO" | "WARN" | "CRITICAL";
  externalId: string;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
};

// G1: bugünkü harcama > 2 × günlük bütçe ya da Pazar'dan beri harcama >
// 7,35 × günlük bütçe. Günlük bütçesi olmayan (ömür boyu bütçeli) nesnede
// kural uygulanmaz: Meta ömür boyu bütçeyi kendi takvimine göre dağıtır.
export function runawaySpend(input: {
  dailyBudgetMinor: number | null;
  todaySpendMinor: number;
  weekSpendMinor: number;
}): "daily" | "weekly" | null {
  const budget = input.dailyBudgetMinor;
  if (!budget || budget <= 0) return null;
  if (input.todaySpendMinor > budget * RUNAWAY_DAILY_FACTOR) return "daily";
  if (input.weekSpendMinor > budget * RUNAWAY_WEEKLY_FACTOR) return "weekly";
  return null;
}

export type GuardObject = {
  externalId: string;
  level: "CAMPAIGN" | "ADSET" | "AD";
  name: string;
  parentExternalId: string | null;
  campaignExternalId: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
  // Agentelse'in aynada nesneyi ilk gördüğü an (PENDING_REVIEW süresi için).
  firstSeenAt?: Date | null;
  goneAt: Date | null;
  budgetRemainingMinor: number | null;
  issues: unknown;
  reviewFeedback: unknown;
};

function display(name: string): string {
  return nameWithoutTag(name);
}

// Meta'nın `ad_review_feedback` / `issues_info` metninden kısa açıklama.
export function feedbackText(feedback: unknown): string | null {
  if (!feedback) return null;
  if (Array.isArray(feedback)) {
    const first = feedback[0] as Record<string, unknown> | undefined;
    const message = first?.error_message ?? first?.error_summary ?? first?.summary;
    return typeof message === "string" ? message : null;
  }
  if (typeof feedback === "object") {
    const record = feedback as Record<string, unknown>;
    const global = record.global as Record<string, unknown> | undefined;
    if (global && typeof global === "object") {
      const first = Object.entries(global)[0];
      if (first) return `${first[0]}: ${String(first[1])}`;
    }
    const firstValue = Object.values(record)[0];
    return typeof firstValue === "string" ? firstValue : null;
  }
  return null;
}

function running(object: GuardObject, now: Date): boolean {
  if (object.goneAt) return false;
  if (object.endTime && object.endTime.getTime() <= now.getTime()) return false;
  return object.configuredStatus === "ACTIVE";
}

// G5: ret, sorunlu nesne, ödeme beklemesi, uzayan inceleme.
export function deliveryFindings(
  objects: GuardObject[],
  now: Date,
): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const adsByAdSet = new Map<string, GuardObject[]>();
  for (const object of objects) {
    if (object.level === "AD" && object.parentExternalId) {
      const list = adsByAdSet.get(object.parentExternalId) ?? [];
      list.push(object);
      adsByAdSet.set(object.parentExternalId, list);
    }
  }
  for (const object of objects) {
    if (!running(object, now)) continue;
    const status = object.effectiveStatus;
    if (object.level === "AD" && status === "DISAPPROVED") {
      findings.push({
        kind: "AD_DISAPPROVED",
        severity: "WARN",
        externalId: object.externalId,
        title: `Meta rejected an ad: ${display(object.name)}`,
        detail:
          (feedbackText(object.reviewFeedback) ?? "The ad doesn't meet Meta's advertising standards.") +
          " Rejected ads can't be edited; make a new creative.",
      });
    } else if (status === "WITH_ISSUES") {
      findings.push({
        kind: "DELIVERY_ISSUE",
        severity: "WARN",
        externalId: object.externalId,
        title: `Meta reports a problem: ${display(object.name)}`,
        detail: feedbackText(object.issues) ?? "Delivery has an issue. Open it in Ads Manager.",
      });
    } else if (status === "PENDING_BILLING_INFO") {
      findings.push({
        kind: "BILLING_HOLD",
        severity: "CRITICAL",
        externalId: object.externalId,
        title: "Ads are waiting for payment details",
        detail: "Add a payment method in Meta Billing so your ads can run.",
      });
    } else if (status === "PENDING_REVIEW" && object.level === "AD") {
      const since = object.firstSeenAt ?? object.createdAt;
      if (now.getTime() - since.getTime() > REVIEW_SLOW_MS) {
        findings.push({
          kind: "REVIEW_SLOW",
          severity: "INFO",
          externalId: object.externalId,
          title: `Meta's review is taking longer than a day: ${display(object.name)}`,
          detail: "Reviews usually finish within 24 hours. Nothing to do yet.",
        });
      }
    }
  }
  // Bir ad set'in bütün çalışan reklamları reddedildiyse CRITICAL.
  for (const [adSetId, ads] of adsByAdSet) {
    const live = ads.filter((ad) => running(ad, now));
    if (live.length > 0 && live.every((ad) => ad.effectiveStatus === "DISAPPROVED")) {
      const adSet = objects.find((object) => object.externalId === adSetId);
      if (adSet && running(adSet, now)) {
        findings.push({
          kind: "ALL_ADS_REJECTED",
          severity: "CRITICAL",
          externalId: adSetId,
          title: `All ads were rejected in ${display(adSet.name)}`,
          detail: "Nothing in this ad set can run. Make new creatives to continue.",
        });
      }
    }
  }
  return findings;
}

// G8: teslimat yok. Yalnız gerçekten çalışması gereken ad set: configured ve
// effective ACTIVE, başlamış ve bitmemiş, bütçesi kalmış, en az bir reklamı
// incelemede değil; 24 saattir 0 gösterim. Hesap harcama tavanı dolduysa
// neden o kural (G9) olduğu için burada raporlanmaz.
export function noDeliveryFindings(input: {
  objects: GuardObject[];
  // Ad set başına son 24 saatin (dün + bugün, hesap günü) gösterimi.
  impressionsByAdSet: ReadonlyMap<string, number>;
  accountCapReached: boolean;
  now: Date;
}): GuardFinding[] {
  if (input.accountCapReached) return [];
  const { now } = input;
  const findings: GuardFinding[] = [];
  const campaigns = new Map(
    input.objects
      .filter((object) => object.level === "CAMPAIGN")
      .map((object) => [object.externalId, object]),
  );
  for (const adSet of input.objects) {
    if (adSet.level !== "ADSET" || adSet.goneAt) continue;
    if (adSet.configuredStatus !== "ACTIVE" || adSet.effectiveStatus !== "ACTIVE") continue;
    const started = adSet.startTime ?? adSet.createdAt;
    if (now.getTime() - started.getTime() < NO_DELIVERY_AFTER_MS) continue;
    if (adSet.endTime && adSet.endTime.getTime() <= now.getTime()) continue;
    if (adSet.budgetRemainingMinor !== null && adSet.budgetRemainingMinor <= 0) continue;
    const campaign = adSet.campaignExternalId
      ? campaigns.get(adSet.campaignExternalId)
      : undefined;
    if (campaign && campaign.effectiveStatus !== "ACTIVE") continue;
    if (campaign?.budgetRemainingMinor !== null && campaign?.budgetRemainingMinor !== undefined && campaign.budgetRemainingMinor <= 0) continue;
    const ads = input.objects.filter(
      (object) =>
        object.level === "AD" &&
        object.parentExternalId === adSet.externalId &&
        !object.goneAt &&
        object.configuredStatus === "ACTIVE",
    );
    if (ads.length === 0) continue;
    if (ads.every((ad) => ad.effectiveStatus !== "ACTIVE")) continue;
    if ((input.impressionsByAdSet.get(adSet.externalId) ?? 0) > 0) continue;
    findings.push({
      kind: "NO_DELIVERY",
      severity: "WARN",
      externalId: adSet.externalId,
      title: `Not delivering: ${display(adSet.name)}`,
      detail:
        "This ad set is on but got no impressions in the last 24 hours. Common causes: budget below Meta's minimum, a very small audience, or ads waiting for review.",
    });
  }
  return findings;
}
