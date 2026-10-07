import { addDays } from "@/lib/website-analytics/days";

// MH25 "Agentelse UTM kapsamı" (GA-F6, docs/website-attribution.md). GA-F3
// bu kontrolü GA-F6'ya bıraktı. GA_CHECK_KEYS'e EKLENMEZ: kontrol satırı,
// puan, uyarı ve Telegram yok; her görüntülemede hesaplanır, yalnız ölçüm
// sağlığı panelinin altında görünür. Önem düzeyi daima INFO. Saf ve izomorfik.

export const MH25_KEY = "MH25";

export const UTM_COVERAGE = {
  windowDays: 28,
  minCoverage: 0.9,
  seenAfterDays: 2,
  minClicksForSeen: 20,
  maxAds: 500,
} as const;

export type UtmCoverageAd = {
  adExternalId: string;
  // Son 28 günde ilk link tıklaması olan gün ("YYYY-MM-DD", hesap günü)
  firstClickDay: string;
  linkClicks: number;
  // Kod GA'ya gerçekten ulaşan (carriesCode) bir TrackedLink var mı
  tagged: boolean;
  code: string | null;
  utmCampaign: string | null;
};

export type UtmCoverageInput = {
  // Ambarın kapsadığı son GA günü
  dataThrough: string | null;
  ads: readonly UtmCoverageAd[];
  // firstClickDay'den sonraki campaign dilimlerinde görülen kodlar ve agx-
  // kampanyaları (kampanyalar küçük harf)
  seen: { codes: readonly string[]; campaigns: readonly string[] };
};

export type UtmCoverageReason =
  | "ok"
  | "no_ads"
  | "no_data"
  | "low_coverage"
  | "not_seen";

export type UtmCoverageResult = {
  key: "MH25";
  status: "PASS" | "WARN" | "UNKNOWN";
  severity: "INFO";
  evidence: {
    reason: UtmCoverageReason;
    ads: number;
    tagged: number;
    coveragePct: number | null;
    unseen: number;
  };
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function result(
  status: UtmCoverageResult["status"],
  evidence: UtmCoverageResult["evidence"],
): UtmCoverageResult {
  return { key: MH25_KEY, status, severity: "INFO", evidence };
}

export function evaluateUtmCoverage(input: UtmCoverageInput): UtmCoverageResult {
  const ads = input.ads.length;
  const tagged = input.ads.filter((ad) => ad.tagged).length;
  if (!input.dataThrough) {
    return result("UNKNOWN", {
      reason: "no_data",
      ads,
      tagged,
      coveragePct: null,
      unseen: 0,
    });
  }
  if (ads === 0) {
    return result("UNKNOWN", {
      reason: "no_ads",
      ads: 0,
      tagged: 0,
      coveragePct: null,
      unseen: 0,
    });
  }
  const coveragePct = round1((tagged / ads) * 100);

  // Kodu GA'da görünmesi gereken reklamlar: etiketli, yeterli tıklama almış ve
  // ilk tıklaması son GA gününden en az 2 gün önce.
  const cutoff = addDays(input.dataThrough, -UTM_COVERAGE.seenAfterDays);
  const seenCodes = new Set(input.seen.codes.map((code) => code.toLowerCase()));
  const seenCampaigns = new Set(
    input.seen.campaigns.map((campaign) => campaign.toLowerCase()),
  );
  const unseen = input.ads.filter(
    (ad) =>
      ad.tagged &&
      ad.linkClicks >= UTM_COVERAGE.minClicksForSeen &&
      ad.firstClickDay <= cutoff &&
      !(ad.code !== null && seenCodes.has(ad.code.toLowerCase())) &&
      !(
        ad.utmCampaign !== null && seenCampaigns.has(ad.utmCampaign.toLowerCase())
      ),
  ).length;

  const evidence = { ads, tagged, coveragePct, unseen };
  if (coveragePct < UTM_COVERAGE.minCoverage * 100) {
    return result("WARN", { reason: "low_coverage", ...evidence });
  }
  if (unseen > 0) {
    return result("WARN", { reason: "not_seen", ...evidence });
  }
  return result("PASS", { reason: "ok", ...evidence });
}

const TITLES: Record<UtmCoverageReason, string> = {
  low_coverage: "Some ads Agentelse created have no tracking tags",
  not_seen: "Tagged ad visits aren't showing up in Google Analytics",
  ok: "Agentelse links carry tracking",
  no_ads: "No Agentelse ads to check yet",
  no_data: "Waiting for Google Analytics data",
};

export function utmCoverageTitle(result: UtmCoverageResult): string {
  return TITLES[result.evidence.reason];
}

// Yalnız sayılar: ne adres ne ad ne de kimlik içerir.
export function utmCoverageText(result: UtmCoverageResult): string {
  const { reason, ads, tagged, coveragePct, unseen } = result.evidence;
  switch (reason) {
    case "low_coverage":
      return `${tagged} of ${ads} ads that sent visitors in the last ${UTM_COVERAGE.windowDays} days carry Agentelse tracking tags (${coveragePct ?? 0}%). Ads made outside the new launch flow, or links that already had their own utm_content, can't be matched to website visits.`;
    case "not_seen":
      return `${unseen} tagged ${unseen === 1 ? "ad" : "ads"} got clicks at least two days ago, but Google Analytics shows no visits with their tags yet. Check that the landing page loads the Google tag and keeps the link's tags on redirects.`;
    case "ok":
      return `${tagged} of ${ads} ads that sent visitors in the last ${UTM_COVERAGE.windowDays} days carry Agentelse tracking tags.`;
    case "no_ads":
      return "No ads created by Agentelse sent visitors to your website in the last 28 days.";
    case "no_data":
      return "Google Analytics data has not arrived yet.";
  }
}

export const UTM_COVERAGE_GUIDE: { title: string; steps: readonly string[] } = {
  title: "Get Agentelse ads matched to website visits",
  steps: [
    "Launch ads through Review & launch, so Agentelse adds its tracking tags to the ad link.",
    "Don't put your own utm_content in the ad link. If one is already there, Agentelse keeps yours and can't match the ad to visits.",
    "Check that your site's redirects keep the query parameters (everything after the ? in the link).",
    "Check that the landing page loads the Google tag, so Google Analytics can read the tags.",
  ],
};
