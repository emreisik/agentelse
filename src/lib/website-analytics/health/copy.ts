import {
  formatCount,
  formatPercent,
} from "@/lib/module-flows/analytics/format";
import type {
  GaCheckEvidence,
  GaCheckKey,
} from "@/lib/website-analytics/health/types";
import type { MeasurementCheckView } from "@/lib/website-analytics/health/view-types";

// Ölçüm sağlığı kontrol satırlarının tek cümlelik açıklaması (GA-F3):
// (anahtar, neden) başına bir İngilizce cümle, en çok 160 karakter. Sayılar
// kanıttan formatCount/formatPercent ile; günler en-US "Oct 5" (UTC). Ham
// JSON yok; bilinmeyen neden "We couldn't check this yet." olur. Saf.

const MAX_LENGTH = 160;
const FALLBACK = "We couldn't check this yet.";
const MAX_SUSPECT_DAYS = 5;

type Facts = {
  evidence: GaCheckEvidence;
  timeZone: string;
};

type Describe = (facts: Facts) => string;

// --- Kanıt okuyucuları (yanlış tür → null; NaN asla metne girmez) ---

function num(evidence: GaCheckEvidence, field: string): number | null {
  const value = evidence[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(evidence: GaCheckEvidence, field: string): string | null {
  const value = evidence[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function list(evidence: GaCheckEvidence, field: string): string[] {
  const value = evidence[field];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim() !== "")
    : [];
}

// Google'dan gelen etiketler zaten maskeli; burada yalnız kısaltılır ve
// süslü parantez temizlenir (cümlede ham JSON izlenimi olmasın).
function label(value: string, max = 40): string {
  const clean = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function count(value: number): string {
  return formatCount(Math.round(value));
}

// Kesir (0.123) → "12.3%".
function percent(fraction: number): string {
  return formatPercent(Math.round(fraction * 1000) / 10);
}

const DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function decimal(value: number): string {
  return DECIMAL.format(value);
}

function plural(value: number, one: string, many: string): string {
  return Math.round(value) === 1 ? one : many;
}

// "2026-10-05" → "Oct 5" (UTC; mülk günü olduğu gibi).
function dayLabel(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function dayOf(evidence: GaCheckEvidence, field: string): string | null {
  const value = text(evidence, field);
  return value ? dayLabel(value) : null;
}

// ISO zaman damgası → mülk saat diliminde "Oct 5".
function dateOf(
  evidence: GaCheckEvidence,
  field: string,
  timeZone: string,
): string | null {
  const value = text(evidence, field);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone,
    }).format(date);
  } catch {
    return dayLabel(date.toISOString().slice(0, 10));
  }
}

function joinLabels(values: string[], max: number): string {
  return values
    .slice(0, max)
    .map((value) => label(value, 30))
    .join(", ");
}

// --- Ortak cümleler ---

const COMMON: Record<string, string> = {
  error: "We couldn't run this check this time. We'll try again soon.",
  not_checked: "We haven't checked this yet.",
  not_ready: "Waiting for the first complete day of Google Analytics data.",
  low_volume: "Too few visits in the last 28 days to judge this yet.",
  low_history: "Not enough history yet to compare with.",
  no_data: "No Google Analytics data to check yet.",
  not_read: "We couldn't read this setting from Google Analytics yet.",
  no_domain: "Add your website address to the project so we can check this.",
};

// --- Anahtar başına cümleler ---

const MH1: Record<string, Describe> = {
  ok: ({ evidence }) => {
    const sessions = num(evidence, "sessions");
    const day = dayOf(evidence, "day");
    if (evidence.mode === "week" && sessions !== null) {
      return `${count(sessions)} visits in the last 7 days, in line with usual weeks.`;
    }
    return sessions !== null && day
      ? `${count(sessions)} visits on ${day}, in line with the usual level.`
      : "Visits are arriving as usual.";
  },
  stopped: ({ evidence }) => {
    const sessions = num(evidence, "sessions");
    const expected = num(evidence, "expected");
    const day = dayOf(evidence, "day");
    const usual =
      expected !== null ? ` (usually about ${count(expected)})` : "";
    if (evidence.mode === "week") {
      return sessions !== null
        ? `Only ${count(sessions)} visits arrived in the last 7 days${usual}.`
        : "Almost no visits arrived in the last 7 days.";
    }
    if (evidence.synthetic === true || sessions === 0) {
      return day
        ? `No visits arrived on ${day}${usual}.`
        : `No visits arrived on the latest day${usual}.`;
    }
    return sessions !== null && day
      ? `Only ${count(sessions)} ${plural(sessions, "visit", "visits")} arrived on ${day}${usual}.`
      : "Almost no visits arrived on the latest day.";
  },
  dropped: ({ evidence }) => {
    const sessions = num(evidence, "sessions");
    const expected = num(evidence, "expected");
    const day = dayOf(evidence, "day");
    const usual = expected !== null ? `, usually about ${count(expected)}` : "";
    if (evidence.mode === "week") {
      return sessions !== null
        ? `Visits fell to ${count(sessions)} in the last 7 days${usual}.`
        : "Visits fell sharply in the last 7 days.";
    }
    return sessions !== null && day
      ? `Visits fell to ${count(sessions)} on ${day}${usual}.`
      : "Visits fell sharply on the latest day.";
  },
  low_volume: () =>
    "Too few daily visits to tell a normal quiet day from a tracking problem.",
  no_data: () => "No daily Google Analytics data is stored yet.",
  sync_late: () =>
    "Google Analytics updates are late, so we can't judge recent visits yet.",
};

const MH1_RT: Record<string, Describe> = {
  ok: () => "Visitors are showing up in Google Analytics today.",
  no_live_visitors: ({ evidence }) => {
    const zeros = num(evidence, "zeros");
    return zeros !== null
      ? `No live visitors in ${count(zeros)} checks in a row today, although this site usually has visits.`
      : "No live visitors in several checks today, although this site usually has visits.";
  },
  not_checked: () =>
    "Live visitors are checked during the day for sites with steady traffic.",
};

const MH2: Record<string, Describe> = {
  ok: () => "Yesterday's data has arrived from Google Analytics.",
  late: ({ evidence }) => {
    const expected = dayOf(evidence, "expectedDay");
    const latest = dayOf(evidence, "latestDay");
    if (expected && latest) {
      return `Data for ${expected} hasn't arrived yet. The latest day we have is ${latest}.`;
    }
    return expected
      ? `Data for ${expected} hasn't arrived yet.`
      : "Yesterday's data hasn't arrived yet.";
  },
  not_checked: () =>
    "We'll check this once the Google Analytics connection is healthy.",
};

const MH3: Record<string, Describe> = {
  ok: ({ evidence, timeZone }) => {
    const found = num(evidence, "pagesWithExpected");
    const checked = num(evidence, "pagesChecked");
    const on = dateOf(evidence, "checkedAt", timeZone);
    const when = on ? ` on ${on}` : "";
    return found !== null && checked !== null && checked > 0
      ? `Your Google Analytics tag was found on ${count(found)} of ${count(checked)} pages we checked${when}.`
      : "Your Google Analytics tag was found on your website.";
  },
  not_checked: () => "We haven't checked your website for the tag yet.",
  no_site: () =>
    "Add your website address to the project so we can look for the tag.",
  robots: () =>
    "Your website's robots.txt asks us not to visit, so we couldn't look for the tag.",
  fetch_failed: () => "We couldn't open your website to look for the tag.",
  no_measurement_id: () =>
    "We don't know this property's G- measurement ID yet, so we couldn't match the tag.",
  other_id: ({ evidence }) => {
    const ids = list(evidence, "otherIds");
    return ids.length > 0
      ? `Your website sends data to ${joinLabels(ids, 3)}, not to this property.`
      : "Your website sends data to a different Google Analytics ID.";
  },
  gtm_only: () =>
    "Your website uses Google Tag Manager, so the tag isn't visible in the page. Check it with Tag Assistant.",
  google_tag_only: () =>
    "Your website loads a combined Google tag. Check with Tag Assistant that it sends data to this property.",
  client_side: () =>
    "We couldn't see the tag in the page code, but data arrives, so a script probably adds it.",
  missing: ({ evidence }) => {
    const checked = num(evidence, "pagesChecked");
    return checked !== null && checked > 0
      ? `We couldn't find the Google Analytics tag on any of the ${count(checked)} pages we checked.`
      : "We couldn't find the Google Analytics tag on your website.";
  },
};

const MH4: Record<string, Describe> = {
  ok: () => "No sign of visits being counted twice.",
  double_load: () =>
    "The Google Analytics tag loads twice on your website, for example through gtag.js and Tag Manager.",
  double_count_data: ({ evidence }) => {
    const current = num(evidence, "viewsPerSession");
    const base = num(evidence, "baselineViewsPerSession");
    return current !== null && base !== null
      ? `Pages per visit jumped to ${decimal(current)} (usually ${decimal(base)}), which points to double counting.`
      : "Pages per visit jumped sharply, which points to double counting.";
  },
  low_volume: () => "Too few visits last week to check for double counting.",
};

const MH5: Record<string, Describe> = {
  ok: ({ evidence }) => {
    const total = num(evidence, "count");
    return total !== null && total > 0
      ? `${count(total)} key ${plural(total, "event is", "events are")} set up.`
      : "Key events are set up.";
  },
  not_read: () => "We couldn't read your key events from Google Analytics yet.",
  no_key_events: ({ evidence }) => {
    const suggestions = list(evidence, "suggestions");
    return suggestions.length > 0
      ? `No key events are set up yet. Good first ones for your site: ${joinLabels(suggestions, 3)}.`
      : "No key events are set up, so leads and sales aren't counted.";
  },
  only_purchase: () =>
    "Only purchase is a key event and no sales are recorded. Add lead events such as generate_lead too.",
};

const MH6: Record<string, Describe> = {
  ok: () => "Key events are arriving as usual.",
  no_key_events: () =>
    "No key events are set up, so there's nothing to compare.",
  low_history: () => "Not enough history yet to compare key events.",
  stopped: ({ evidence }) => {
    const base = num(evidence, "dailyBaseline");
    return base !== null
      ? `No key events in the last 7 days, although there were usually about ${decimal(base)} a day.`
      : "No key events in the last 7 days, although there usually are some.";
  },
  double_fire: ({ evidence }) => {
    const last7 = num(evidence, "last7");
    const base = num(evidence, "dailyBaseline");
    return last7 !== null && base !== null
      ? `${count(last7)} key events in the last 7 days (usually about ${decimal(base)} a day). They may fire twice.`
      : "Key events jumped sharply in the last 7 days. They may fire twice.";
  },
};

const MH7: Record<string, Describe> = {
  ok: () => "Almost all visits have a channel.",
  high_unassigned: ({ evidence }) => {
    const share = num(evidence, "share");
    const sessions = num(evidence, "sessions");
    if (share === null) return "Many visits have no channel (Unassigned).";
    return sessions !== null
      ? `${percent(share)} of visits (${count(sessions)}) in the last 28 days have no channel (Unassigned).`
      : `${percent(share)} of visits in the last 28 days have no channel (Unassigned).`;
  },
};

const MH8: Record<string, Describe> = {
  ok: () => "UTM tags are written consistently.",
  utm_variants: ({ evidence }) => {
    const [variant] = list(evidence, "variants");
    const [medium] = list(evidence, "mediums");
    if (variant) {
      return `Some UTM tags are written in different ways, for example ${label(variant)}.`;
    }
    return medium
      ? `Some links use a non-standard medium, for example ${label(medium)}.`
      : "Some UTM tags are written in different ways.";
  },
};

const MH9: Record<string, Describe> = {
  ok: () => "Your own site doesn't show up as a referrer.",
  self_referral: ({ evidence }) => {
    const share = num(evidence, "share");
    const domain = text(evidence, "domain");
    if (share === null) return "Your own site shows up as a referrer.";
    return domain
      ? `${percent(share)} of visits are credited to your own site (${label(domain)}) as a referrer.`
      : `${percent(share)} of visits are credited to your own site as a referrer.`;
  },
};

const MH10: Record<string, Describe> = {
  ok: () => "Payment and login pages don't show up as referrers.",
  gateway_referrals: ({ evidence }) => {
    const share = num(evidence, "share");
    const [source] = list(evidence, "sources");
    const example = source ? ` such as ${label(source)}` : "";
    return share !== null
      ? `${percent(share)} of visits are credited to payment or login pages${example}.`
      : `Some visits are credited to payment or login pages${example}.`;
  },
};

const MH11: Record<string, Describe> = {
  ok: () => "Almost all visits have a landing page.",
  not_set_landing: ({ evidence }) => {
    const share = num(evidence, "share");
    const sessions = num(evidence, "sessions");
    if (share === null) return "Many visits have no landing page (not set).";
    return sessions !== null
      ? `${percent(share)} of visits (${count(sessions)}) have no landing page (not set).`
      : `${percent(share)} of visits have no landing page (not set).`;
  },
};

const MH12: Record<string, Describe> = {
  ok: () => "No personal data found in page addresses.",
  pii_in_url: ({ evidence }) => {
    const pages = num(evidence, "pages");
    const kinds = [
      ...(evidence.email === true ? ["email addresses"] : []),
      ...(evidence.phone === true ? ["phone numbers"] : []),
    ];
    const params = list(evidence, "params");
    const what =
      kinds.length > 0
        ? kinds.join(" and ")
        : params.length > 0
          ? `parameters like ${joinLabels(params, 3)}`
          : "personal data";
    return pages !== null && pages > 0
      ? `Page addresses on ${count(pages)} ${plural(pages, "page", "pages")} sent ${what} to Google Analytics.`
      : `Page addresses sent ${what} to Google Analytics.`;
  },
  pii_in_path: ({ evidence }) => {
    const days = num(evidence, "markerDays");
    return days !== null && days > 0
      ? `Personal data appeared in page addresses on ${count(days)} of the last 7 days.`
      : "Personal data appeared in page addresses in the last 7 days.";
  },
  recent_history: () =>
    "Personal data appeared in page addresses in the last week; today's data looks clean.",
  not_checked: () => "We haven't checked page addresses for personal data yet.",
};

const MH13: Record<string, Describe> = {
  ok: () => "The property's time zone matches the project.",
  no_project_tz: () =>
    "The project has no publishing time zone to compare with yet.",
  not_read: () => "We couldn't read the property's time zone yet.",
  invalid_tz: () =>
    "One of the time zones isn't recognised, so we couldn't compare them.",
  timezone_mismatch: ({ evidence }) => {
    const property = text(evidence, "propertyTimeZone");
    const project = text(evidence, "projectTimeZone");
    return property && project
      ? `The property uses ${label(property)}, but the project uses ${label(project)}.`
      : "The property's time zone differs from the project's.";
  },
};

const MH14: Record<string, Describe> = {
  ok: () => "Event data is kept for more than two months.",
  two_months: () =>
    "Event data is kept for only two months, so older reports lose detail.",
};

const MH15: Record<string, Describe> = {
  ok: () => "Google Ads is linked to this property.",
  no_paid_search: () => "No Google Ads visits, so no link is needed.",
  ads_not_linked: ({ evidence }) => {
    const paid = num(evidence, "paidSessions");
    return paid !== null
      ? `${count(paid)} visits came from Google Ads in the last 28 days, but Google Ads isn't linked.`
      : "Visits come from Google Ads, but Google Ads isn't linked.";
  },
};

const MH16: Record<string, Describe> = {
  ok: () => "Search Console is linked in Google Analytics.",
  not_linked: () =>
    "Search Console isn't linked in Google Analytics. This is optional.",
  catalog_off: () => "We couldn't check the Search Console link yet.",
};

const MH17: Record<string, Describe> = {
  ok: ({ evidence }) => {
    const seen = list(evidence, "seen");
    return seen.length > 0
      ? `Enhanced measurement events arrive, such as ${joinLabels(seen, 3)}.`
      : "Enhanced measurement events arrive.";
  },
  enhanced_off: () =>
    "No scroll, click or form events in the last 28 days, so enhanced measurement looks off.",
};

const MH18: Record<string, Describe> = {
  ok: () => "Google hides few or no values in your reports.",
  thresholding: ({ evidence }) => {
    const share = num(evidence, "share");
    return share !== null
      ? `Google hides small values in ${percent(share)} of reports to protect privacy.`
      : "Google hides small values in some reports to protect privacy.";
  },
};

const MH19: Record<string, Describe> = {
  ok: () => "Few or no rows are grouped as (other).",
  other_row: ({ evidence }) => {
    const reports = list(evidence, "reports").length;
    return reports > 0
      ? `${count(reports)} ${plural(reports, "report groups", "reports group")} some rows as (other) because of too many values.`
      : "Some reports group rows as (other) because of too many values.";
  },
};

const MH20: Record<string, Describe> = {
  ok: () => "No bot or spam waves found.",
  bot_wave: ({ evidence }) => {
    const sessions = num(evidence, "sessions");
    const name = text(evidence, "label");
    const spikes = evidence.spikeDays;
    const dayCount = Array.isArray(spikes)
      ? spikes.length
      : typeof spikes === "number" && Number.isFinite(spikes)
        ? spikes
        : null;
    const from = name ? ` from ${label(name)}` : "";
    const when =
      dayCount !== null && dayCount > 0
        ? ` on ${count(dayCount)} ${plural(dayCount, "day", "days")}`
        : "";
    return sessions !== null
      ? `${count(sessions)} visits${from}${when} had almost no engagement, which looks like bots or spam.`
      : `A wave of visits${from}${when} had almost no engagement, which looks like bots or spam.`;
  },
};

const MH21: Record<string, Describe> = {
  ok: () => "The property's website matches your project.",
  no_stream: () => "The property has no web data stream to compare with.",
  domain_mismatch: ({ evidence }) => {
    const stream = text(evidence, "streamHost");
    const project = text(evidence, "projectDomain");
    return stream && project
      ? `The property tracks ${label(stream)}, but your project's website is ${label(project)}.`
      : "The property tracks a different website than your project.";
  },
};

const MH22: Record<string, Describe> = {
  ok: () => "Engagement time is recorded.",
  no_engagement_time: ({ evidence }) => {
    const seconds = num(evidence, "secondsPerSession");
    return seconds !== null
      ? `Visits record only ${decimal(seconds)} seconds of engagement on average, so user_engagement is probably missing.`
      : "Visits record almost no engagement time, so user_engagement is probably missing.";
  },
};

const MH23: Record<string, Describe> = {
  ok: () => "A cookie consent signal was found on your website.",
  few_eu: () =>
    "Few visits come from the EU or EEA, so a consent signal matters less here.",
  not_checked: () =>
    "We haven't checked your website for a consent signal yet.",
  gtm_only: () =>
    "Your website uses Google Tag Manager, so check the consent settings there.",
  no_consent_default: ({ evidence }) => {
    const share = num(evidence, "euShare");
    return share !== null
      ? `${percent(share)} of visits come from the EU or EEA, but no Consent Mode default was found.`
      : "Many visits come from the EU or EEA, but no Consent Mode default was found.";
  },
};

const MH24: Record<string, Describe> = {
  ok: () => "The Google Analytics connection is healthy.",
  credential: () =>
    "The Google sign-in for this project has to be reconnected.",
  auth: () => "Google rejected our access. Reconnect Google Analytics.",
  needs_permission: () =>
    "Agentelse needs more access to this property. Reconnect and allow access.",
  access_lost: () =>
    "We lost access to this property. Check that your Google account can still open it.",
  gone: () =>
    "This property no longer exists in Google Analytics. Choose another one.",
  api_disabled: () =>
    "The Google Analytics API is turned off for this property.",
  sync_failing: () =>
    "Recent Google Analytics updates are failing. We keep retrying.",
  sync_late: ({ evidence }) => {
    const latest = dayOf(evidence, "latestDay");
    return latest
      ? `Google Analytics updates are late. The latest data we have is from ${latest}.`
      : "Google Analytics updates are late.";
  },
  no_data: () => "No data has arrived from Google Analytics yet.",
};

const BY_KEY: Record<GaCheckKey, Record<string, Describe>> = {
  MH1,
  MH1_RT,
  MH2,
  MH3,
  MH4,
  MH5,
  MH6,
  MH7,
  MH8,
  MH9,
  MH10,
  MH11,
  MH12,
  MH13,
  MH14,
  MH15,
  MH16,
  MH17,
  MH18,
  MH19,
  MH20,
  MH21,
  MH22,
  MH23,
  MH24,
};

function clip(sentence: string): string {
  return sentence.length > MAX_LENGTH
    ? `${sentence.slice(0, MAX_LENGTH - 1).trimEnd()}…`
    : sentence;
}

export function describeCheck(
  check: MeasurementCheckView,
  options: { timeZone?: string } = {},
): string {
  const evidence = check.evidence ?? {};
  const reason = typeof evidence.reason === "string" ? evidence.reason : null;
  if (!reason) return FALLBACK;
  const describe = Object.hasOwn(BY_KEY, check.key)
    ? BY_KEY[check.key][reason]
    : undefined;
  if (describe) {
    try {
      const sentence = describe({
        evidence,
        timeZone: options.timeZone ?? "UTC",
      });
      if (sentence) return clip(sentence);
    } catch {
      // Beklenmeyen kanıt cümleyi düşürmesin; ortak metne düşülür.
    }
  }
  return (Object.hasOwn(COMMON, reason) ? COMMON[reason] : null) ?? FALLBACK;
}

export function suspectDaysText(days: string[]): string | null {
  const labels = [...new Set(days)]
    .sort()
    .map(dayLabel)
    .filter((value): value is string => value !== null);
  if (labels.length === 0) return null;
  // En yeni 5 gün gösterilir; kalan eski günler "+N more".
  const shown = labels.slice(-MAX_SUSPECT_DAYS);
  const more = labels.length - shown.length;
  return `Left out of trends because of tracking problems: ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}.`;
}
