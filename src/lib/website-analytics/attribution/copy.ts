// GA-F6 atıf bölümlerinin kullanıcıya görünen metinleri (UI İngilizce).
// Her sütun kaynağını başlıkta taşır: "(Meta)" ya da "(GA4)".

export const ATTRIBUTION_COPY = {
  fromTitle: "From Agentelse",
  fromHint:
    "Visits that came through links Agentelse tagged: ads and your bio link.",
  trackedOnly:
    "Only visits through links Agentelse tagged are counted. People who reach your site from your profile without a tagged link show up under Organic Social.",
  otherTagged: "Other tagged links",
  adsTitle: "Your ads on your website",
  metaWindowNote:
    "Meta counts a result up to 7 days after a click or 1 day after a view. GA4 credits each visit to the source it came from, so the two never match exactly; a big gap is worth a tracking check.",
  dayAlignmentNote:
    "Meta days follow your ad account's time zone; GA4 days follow your property's.",
  adLevelNote:
    "Only ads Agentelse created and tagged are compared; other ads in the same campaign are left out on both sides.",
  coverageNote: (covered: number, days: number) =>
    covered > 0
      ? `Meta numbers cover only the ${covered} of ${days} days that have campaign detail in Google Analytics, so both sides count the same days.`
      : "Google Analytics has no campaign detail for these days yet, so Meta and GA4 are not compared.",
  notSynced: "Meta numbers appear here once your ad account is synced.",
  metaPending: "Meta numbers appear once these ads have run and synced.",
  mixedCurrency:
    "Your ad accounts use different currencies, so spend is not shown.",
  googleAdsTitle: "Google Ads (from GA4)",
  googleAdsNote:
    "Cost and clicks come from Google Ads through your Google Analytics link; key events and revenue from GA4.",
  truncated:
    "Google Analytics leaves out some small campaigns on busy days, so these totals can be a little low.",
  clickLossFlag: "Many clicks never arrive",
  resultsGapFlag: "Meta and GA4 counts differ",
  currencyNote: (meta: string, ga: string) =>
    `Ad spend is in ${meta}; website revenue is in ${ga}.`,
  columns: {
    sessions: "Sessions (GA4)",
    engagement: "Engagement rate",
    keyEvents: "Key events (GA4)",
    revenue: "Revenue (GA4)",
    spend: "Spend (Meta)",
    linkClicks: "Link clicks (Meta)",
    clickToSession: "Clicks → sessions",
    results: "Results (Meta)",
    costPerResult: "Cost per result (Meta)",
    costPerKeyEvent: "Cost per key event (GA4)",
    cost: "Cost",
    clicks: "Clicks",
    roas: "ROAS",
  },
} as const;
