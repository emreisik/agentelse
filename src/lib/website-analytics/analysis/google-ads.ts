import { roasOf } from "@/lib/website-analytics/attribution/google-ads";
import type { GoogleAdsCampaignRow } from "@/lib/website-analytics/attribution/types";
import { maskGoogleText } from "@/server/integrations/google/pii";

import { daysIn } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import { GA_LABEL_MAX } from "./landing-pages";
import { benjaminiHochberg, rateRatioTest } from "./stats";
import type {
  An14Evidence,
  An14Side,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F6 AN14: bir Google Ads kampanyasının key event başına maliyeti son 28
// günde bir öncekine göre belirgin biçimde değişti mi (docs/website-attribution.md
// "AN14"). Girdi google_ads DAY dilimlerinden C paketinin okuyucusunda toplanır;
// bayrak ya da katalog kontrolü kapalıyken yoktur. ROAS yalnız kanıttır.
// Kampanya adı bir Google dizesidir: eşleştirme ham adla yapılır, ama dışarı
// (kanıt, konu, ayrıntı, olgular) yalnız maskelenmiş ad çıkar. Saf modül,
// hata atmaz.

const MIN_CLICKS = 100;
const MIN_KEY_EVENTS = 10;
const MIN_CHANGE_PCT = 20;
const SIGNIFICANT_P = 0.05;
const AN14_MAX = 3;

// Maskelenmiş ve kırpılmış ad (AN12 emsali).
export function maskedAdsCampaign(name: string): string {
  return maskGoogleText(name).trim().slice(0, GA_LABEL_MAX);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Aynı ham ad birden çok satırda gelirse toplanır.
function byRawName(
  rows: readonly GoogleAdsCampaignRow[],
): Map<string, GoogleAdsCampaignRow> {
  const map = new Map<string, GoogleAdsCampaignRow>();
  for (const row of rows) {
    const entry = map.get(row.campaign);
    if (!entry) {
      map.set(row.campaign, { ...row });
      continue;
    }
    entry.cost += row.cost;
    entry.clicks += row.clicks;
    entry.sessions += row.sessions;
    entry.keyEvents += row.keyEvents;
    entry.revenue += row.revenue;
  }
  return map;
}

function passesGates(row: GoogleAdsCampaignRow): boolean {
  return (
    row.clicks >= MIN_CLICKS && row.keyEvents >= MIN_KEY_EVENTS && row.cost > 0
  );
}

function sideOf(row: GoogleAdsCampaignRow): An14Side {
  return {
    cost: row.cost,
    clicks: row.clicks,
    sessions: row.sessions,
    keyEvents: row.keyEvents,
    revenue: row.revenue,
    costPerKeyEvent: row.cost / row.keyEvents,
    // Gelir izlenmiyorsa (0) "ROAS 0×" yazmak yanıltır; null kalır.
    roas: row.revenue > 0 ? roasOf(row.revenue, row.cost) : null,
  };
}

type Test = {
  current: GoogleAdsCampaignRow;
  previous: GoogleAdsCampaignRow;
  campaign: string;
  changePct: number;
  p: number;
};

export function evaluateGoogleAds(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const ads = input.ads?.googleAds;
  if (!input.ads || !ads) return [];
  const previousByName = byRawName(ads.previous);
  const tests: Test[] = [];
  for (const [raw, current] of byRawName(ads.current)) {
    const previous = previousByName.get(raw);
    if (!previous || !passesGates(current) || !passesGates(previous)) continue;
    const campaign = maskedAdsCampaign(raw);
    if (campaign === "") continue;
    const test = rateRatioTest(
      current.keyEvents,
      current.cost,
      previous.keyEvents,
      previous.cost,
    );
    if (!test) continue;
    const before = previous.cost / previous.keyEvents;
    const after = current.cost / current.keyEvents;
    tests.push({
      current,
      previous,
      campaign,
      changePct: round1((after / before - 1) * 100),
      p: test.p,
    });
  }

  // BH ailesi: sınanan bütün kampanyalar birlikte.
  const accepted = benjaminiHochberg(tests.map((test) => test.p));
  const window = input.ads.window;
  const previousWindow = input.ads.previousWindow;
  const excludedDays = [
    ...new Set([
      ...input.window28.excludedDays,
      ...input.window28Previous.excludedDays,
    ]),
  ].sort();
  const holidays = [
    ...new Set([
      ...daysIn(previousWindow, input.holidays),
      ...daysIn(window, input.holidays),
    ]),
  ].sort();

  const ranked: { score: number; candidate: GaFindingCandidate }[] = [];
  tests.forEach((test, index) => {
    const bhAccepted = accepted[index] ?? false;
    if (
      !(test.p < SIGNIFICANT_P) ||
      !bhAccepted ||
      Math.abs(test.changePct) < MIN_CHANGE_PCT
    ) {
      return;
    }
    const worse = test.changePct > 0;
    const evidence: An14Evidence = {
      v: 1,
      rule: "AN14",
      window,
      previousWindow,
      campaign: test.campaign,
      direction: worse ? "worse" : "better",
      current: sideOf(test.current),
      previous: sideOf(test.previous),
      changePct: test.changePct,
      p: test.p,
      bhAccepted,
      excludedDays,
      holidays,
    };
    ranked.push({
      score: Math.abs(test.changePct) * test.current.cost,
      candidate: {
        ruleKey: "AN14",
        kind: worse ? "CHANGE" : "WIN",
        subject: GaSubjects.googleAdsCampaign(test.campaign),
        period: periodOf("WINDOW28", window),
        severity: worse ? "WARN" : "INFO",
        confidence: "SIGNIFICANT",
        evidence,
        impact: null,
        impactShare:
          Math.min(1, Math.max(0, Math.abs(test.changePct) / 100)) * 0.5,
      },
    });
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score || a.candidate.subject.localeCompare(b.candidate.subject),
  );
  // İki ham ad aynı maskeye düşerse aynı parmak izi iki kez oluşmasın.
  const seen = new Set<string>();
  const result: GaFindingCandidate[] = [];
  for (const { candidate } of ranked) {
    if (seen.has(candidate.subject)) continue;
    seen.add(candidate.subject);
    result.push(candidate);
    if (result.length >= AN14_MAX) break;
  }
  return result;
}
