// Ölçüm sağlığı düzeltme rehberleri (docs/google-analytics-plan.md §6.1,
// GA-F3): her kontrolün guideId'si için kısa, İngilizce adımlar. Saf ve
// istemci güvenli; panel "How to fix" altında gösterir. Bağlantılar yalnız
// izinli köklerle başlar (Google Analytics, Tag Assistant, Analytics yardım
// merkezi); derin bağlantılar henüz canlıda doğrulanmadı (açık konu).

export type GaGuide = {
  id: string;
  title: string;
  where: string | null;
  steps: string[];
  links: { label: string; href: string }[];
};

export const GA_GUIDE_LINK_ROOTS: readonly string[] = [
  "https://analytics.google.com/analytics/web/",
  "https://tagassistant.google.com/",
  "https://support.google.com/analytics",
];

// Sık kullanılan bağlantılar tek yerde.
const LINK = {
  analytics: {
    label: "Open Google Analytics",
    href: "https://analytics.google.com/analytics/web/",
  },
  tagAssistant: {
    label: "Open Tag Assistant",
    href: "https://tagassistant.google.com/",
  },
  setup: {
    label: "Set up Google Analytics on a website",
    href: "https://support.google.com/analytics/answer/9304153",
  },
  keyEvents: {
    label: "About key events",
    href: "https://support.google.com/analytics/search?q=key+events",
  },
  campaigns: {
    label: "Campaign URLs (UTM)",
    href: "https://support.google.com/analytics/search?q=utm+campaign+url",
  },
  crossDomain: {
    label: "Cross-domain measurement",
    href: "https://support.google.com/analytics/answer/10071811",
  },
  unwantedReferrals: {
    label: "Identify unwanted referrals",
    href: "https://support.google.com/analytics/answer/10327750",
  },
  retention: {
    label: "Data retention",
    href: "https://support.google.com/analytics/answer/7667196",
  },
  googleAds: {
    label: "Link Google Ads to Google Analytics",
    href: "https://support.google.com/analytics/answer/9379420",
  },
  searchConsole: {
    label: "Search Console integration",
    href: "https://support.google.com/analytics/answer/10737381",
  },
  enhanced: {
    label: "Enhanced measurement events",
    href: "https://support.google.com/analytics/answer/9216061",
  },
  thresholds: {
    label: "Data thresholds",
    href: "https://support.google.com/analytics/search?q=data+thresholds",
  },
  otherRow: {
    label: "About the (other) row",
    href: "https://support.google.com/analytics/search?q=%28other%29+row",
  },
  redaction: {
    label: "Data redaction",
    href: "https://support.google.com/analytics/search?q=data+redaction",
  },
  piiPolicy: {
    label: "Avoid sending personal data",
    href: "https://support.google.com/analytics/search?q=personal+information+best+practices",
  },
  timeZone: {
    label: "Property settings",
    href: "https://support.google.com/analytics/search?q=property+time+zone",
  },
  engagement: {
    label: "User engagement",
    href: "https://support.google.com/analytics/search?q=user_engagement",
  },
  consent: {
    label: "Consent mode",
    href: "https://support.google.com/analytics/answer/9976101",
  },
  botTraffic: {
    label: "Known bot traffic",
    href: "https://support.google.com/analytics/search?q=bot+traffic",
  },
  access: {
    label: "Property access",
    href: "https://support.google.com/analytics/search?q=add+users+access",
  },
} as const;

const TAG_REMOVED_STEPS = [
  "Open your website and make sure the Google Analytics tag (gtag.js or Google Tag Manager) is still on every page.",
  "If a cookie banner was added or changed, check that it doesn't block Google Analytics after visitors accept.",
  "If the site was rebuilt, moved or got a new theme, add the tag again with the same G- measurement ID.",
  "Check the site with Tag Assistant: it should show your G- ID sending a page_view.",
  "After fixing it, press 'I fixed it'. Agentelse checks again and confirms with the next day's data.",
];

const GUIDES: GaGuide[] = [
  {
    id: "ga-mh1",
    title: "Get data flowing into Google Analytics again",
    where: "Google Analytics → Reports → Realtime",
    steps: TAG_REMOVED_STEPS,
    links: [LINK.tagAssistant, LINK.setup, LINK.analytics],
  },
  {
    id: "ga-mh1_rt",
    title: "Check why no visitors show up right now",
    where: "Google Analytics → Reports → Realtime",
    steps: [
      "Open your website in a new browser window and look at the Realtime report: your own visit should appear within a minute.",
      ...TAG_REMOVED_STEPS.slice(0, 4),
    ],
    links: [LINK.tagAssistant, LINK.analytics],
  },
  {
    id: "ga-mh2",
    title: "Yesterday's data is late",
    where: null,
    steps: [
      "No action is needed: Google Analytics sometimes finishes a day late.",
      "Agentelse fetches the day again automatically later today.",
      "If it is still missing tomorrow, check the connection under Connectors.",
    ],
    links: [],
  },
  {
    id: "ga-mh3",
    title: "Put the right Google Analytics tag on your website",
    where: "Admin → Data streams → your web stream",
    steps: [
      "In Google Analytics, open Admin → Data streams and copy the G- measurement ID of your web stream.",
      "Make sure your website's tag uses exactly this G- ID, not one from another property.",
      "If your site uses a combined Google tag (an ID starting with GT-), check in Tag Assistant that it sends data to this G- ID.",
      "If you use Google Tag Manager, check that its Google tag uses the same G- ID and that the container is published.",
      "After fixing it, press 'I fixed it' and Agentelse checks your pages again.",
    ],
    links: [LINK.tagAssistant, LINK.setup, LINK.analytics],
  },
  {
    id: "ga-mh4",
    title: "Stop counting visits twice",
    where: null,
    steps: [
      "Look for two Google Analytics installs on the same page, for example gtag.js in the theme and a Google tag in Google Tag Manager.",
      "Keep one of them: either the gtag.js snippet or the Tag Manager tag, not both.",
      "Check with Tag Assistant that each page sends only one page_view.",
      "After fixing it, press 'I fixed it'. Trends settle with the next days' data.",
    ],
    links: [LINK.tagAssistant],
  },
  {
    id: "ga-mh5",
    title: "Set up key events",
    where: "Admin → Data display → Events",
    steps: [
      "Pick the actions that matter for your business. Lead sites: generate_lead, click_to_call, whatsapp_click or email_click.",
      "Online shops: purchase plus begin_checkout and add_to_cart. Local businesses: get_directions and click_to_call. Content sites: sign_up or newsletter sign-ups.",
      "Make sure the event is sent from your site (with Google Tag Manager or gtag.js) and shows up under Admin → Data display → Events.",
      "Next to the event, choose Mark as key event.",
      "Agentelse picks up the change with the next settings check.",
    ],
    links: [LINK.keyEvents, LINK.tagAssistant, LINK.analytics],
  },
  {
    id: "ga-mh6",
    title: "Fix key events that stopped or fire twice",
    where: "Admin → Data display → Events",
    steps: [
      "If key events stopped: check that the thank-you page or the event's trigger still exists after recent site changes.",
      "If a form or checkout was replaced, set up the event again on the new page or button.",
      "If key events jumped: look for the same event sent twice, for example by gtag.js and Google Tag Manager, or on page reload.",
      "Test the action yourself with Tag Assistant and count how often the event fires.",
      "After fixing it, press 'I fixed it'. Agentelse confirms with the next day's data.",
    ],
    links: [LINK.tagAssistant, LINK.keyEvents],
  },
  {
    id: "ga-mh7",
    title: "Give every visit a channel",
    where: "Reports → Acquisition → Traffic acquisition",
    steps: [
      "Unassigned visits usually come from links with unusual or missing UTM tags.",
      "Use standard values in your links, for example utm_source=instagram&utm_medium=social&utm_campaign=spring_sale.",
      "For newsletters use utm_medium=email; for paid ads use utm_medium=cpc.",
      "Check the source / medium pairs listed here and fix the links that send them.",
    ],
    links: [LINK.campaigns],
  },
  {
    id: "ga-mh8",
    title: "Write UTM tags one way",
    where: null,
    steps: [
      "Choose one spelling for each source and medium, all in lower case (instagram, not Instagram or IG).",
      "Use the standard mediums: social, email, cpc, referral, organic, affiliate.",
      "Update your bio links, ads and newsletters to use the same spelling.",
      "Old visits keep their old spelling; new visits use the fixed one.",
    ],
    links: [LINK.campaigns],
  },
  {
    id: "ga-mh9",
    title: "Stop your own site showing up as a referrer",
    where: "Admin → Data streams → Configure tag settings",
    steps: [
      "Make sure every page of your website has the same Google Analytics tag.",
      "If your site spans several domains (for example a shop on another domain), set up cross-domain measurement in the tag settings.",
      "Add domains that should not count as referrers under List unwanted referrals.",
      "Check the result with Tag Assistant while moving between your domains.",
    ],
    links: [LINK.crossDomain, LINK.unwantedReferrals],
  },
  {
    id: "ga-mh10",
    title: "Stop payment pages taking credit for sales",
    where:
      "Admin → Data streams → Configure tag settings → List unwanted referrals",
    steps: [
      "In Google Analytics, open Admin → Data streams and choose your web stream.",
      "Open Configure tag settings, then List unwanted referrals.",
      "Add your payment and login providers, for example paypal.com, stripe.com or iyzico.com.",
      "Save. New visits keep their original source after paying.",
    ],
    links: [LINK.unwantedReferrals, LINK.analytics],
  },
  {
    id: "ga-mh11",
    title: "Give every visit a landing page",
    where: null,
    steps: [
      "Make sure the page_view is the first event sent on every page.",
      "If a cookie banner delays the tag, check that page_view is sent once visitors accept.",
      "Events sent from your server or an app without a page_view show up as (not set); send them with a page or skip them in reports.",
      "Check a few pages with Tag Assistant: page_view should come before other events.",
    ],
    links: [LINK.tagAssistant],
  },
  {
    id: "ga-mh12",
    title: "Keep personal data out of page addresses",
    where: "Admin → Data streams → Redact data",
    steps: [
      "Find forms that send details in the page address, for example ?email= after a sign-up. Switch them to POST.",
      "In the web stream settings, turn on data redaction for email addresses and add the parameter names shown here.",
      "Agentelse never stores the addresses or the personal details; only counts and parameter names.",
      "After fixing it, press 'I fixed it' and Agentelse checks today's data again.",
    ],
    links: [LINK.redaction, LINK.piiPolicy],
  },
  {
    id: "ga-mh13",
    title: "Match the property's time zone",
    where: "Admin → Property details",
    steps: [
      "In Google Analytics, open Admin → Property details.",
      "Set the reporting time zone to the one your business works in.",
      "The change applies from now on; older data keeps the old time zone.",
    ],
    links: [LINK.timeZone, LINK.analytics],
  },
  {
    id: "ga-mh14",
    title: "Keep event data for 14 months",
    where: "Admin → Data collection and modification → Data retention",
    steps: [
      "In Google Analytics, open Admin → Data collection and modification → Data retention.",
      "Set event data retention to 14 months and save.",
      "This keeps detail for year-over-year reports; standard reports aren't affected.",
    ],
    links: [LINK.retention, LINK.analytics],
  },
  {
    id: "ga-mh15",
    title: "Link Google Ads",
    where: "Admin → Product links → Google Ads links",
    steps: [
      "In Google Analytics, open Admin → Product links → Google Ads links.",
      "Choose Link and select the Google Ads account that runs your ads.",
      "Keep auto-tagging on in Google Ads so visits are attributed to campaigns.",
    ],
    links: [LINK.googleAds, LINK.analytics],
  },
  {
    id: "ga-mh16",
    title: "Link Search Console (optional)",
    where: "Admin → Product links → Search Console links",
    steps: [
      "This is optional: it adds Google search queries to Google Analytics reports.",
      "In Google Analytics, open Admin → Product links → Search Console links and choose Link.",
      "Agentelse also has its own Search Console connector under Connectors.",
    ],
    links: [LINK.searchConsole, LINK.analytics],
  },
  {
    id: "ga-mh17",
    title: "Turn on enhanced measurement",
    where: "Admin → Data streams → your web stream",
    steps: [
      "In Google Analytics, open Admin → Data streams and choose your web stream.",
      "Turn on Enhanced measurement.",
      "Open its settings and keep scrolls, outbound clicks, site search, form interactions and file downloads on.",
    ],
    links: [LINK.enhanced, LINK.analytics],
  },
  {
    id: "ga-mh18",
    title: "See more data despite thresholds",
    where: "Admin → Data display → Reporting identity",
    steps: [
      "Google hides small values when Google signals is on, to protect privacy.",
      "Compare longer date ranges: thresholds matter less with more visits.",
      "Keep reports simple: fewer extra dimensions and parameters mean fewer hidden rows.",
      "If you don't need Google signals, choosing the Device-based reporting identity also helps.",
    ],
    links: [LINK.thresholds],
  },
  {
    id: "ga-mh19",
    title: "Fewer rows grouped as (other)",
    where: null,
    steps: [
      "The (other) row appears when a report has too many different values.",
      "Avoid sending unique values, like IDs or full URLs with parameters, as event parameters or page titles.",
      "Keep custom dimensions to a small set of repeating values.",
    ],
    links: [LINK.otherRow],
  },
  {
    id: "ga-mh20",
    title: "Handle bot or spam waves",
    where: "Admin → Data streams → Configure tag settings",
    steps: [
      "Those days are left out of Agentelse's trends, so your comparisons stay fair.",
      "Look at where the wave came from (country or source shown here).",
      "Exclude the source with a data filter or unwanted referrals in Google Analytics.",
      "If spam keeps coming, add bot protection to your website's forms.",
    ],
    links: [LINK.botTraffic, LINK.unwantedReferrals],
  },
  {
    id: "ga-mh21",
    title: "Choose the property for this website",
    where: "Connectors → Google Analytics",
    steps: [
      "Open Connectors and choose Google Analytics.",
      "Pick the property whose web stream matches your website.",
      "If your website moved to a new domain, update the web stream URL in Google Analytics too.",
    ],
    links: [LINK.analytics],
  },
  {
    id: "ga-mh22",
    title: "Record engagement time",
    where: null,
    steps: [
      "Engagement time comes from the user_engagement event that the Google tag sends by itself.",
      "Use the standard Google tag (gtag.js or the Google tag in Tag Manager) instead of a custom or server-only setup.",
      "Check with Tag Assistant that user_engagement appears when you leave a page.",
    ],
    links: [LINK.engagement, LINK.tagAssistant],
  },
  {
    id: "ga-mh23",
    title: "Send a cookie consent signal",
    where: null,
    steps: [
      "If you have visitors from the EU or EEA, set a Consent Mode default before the Google tag loads.",
      "Most cookie banner tools can send this signal; turn on their Google Consent Mode option.",
      "Check with Tag Assistant that a consent default appears before the first page_view.",
      "This is information, not legal advice.",
    ],
    links: [LINK.consent, LINK.tagAssistant],
  },
  {
    id: "ga-mh24",
    title: "Fix the Google Analytics connection",
    where: "Connectors → Google Analytics",
    steps: [
      "Open Connectors and choose Google Analytics.",
      "If it asks you to reconnect, sign in again with the Google account that has access to the property.",
      "Make sure that account still has at least Viewer access to the property in Google Analytics.",
      "If the property was deleted, choose another property.",
    ],
    links: [LINK.access, LINK.analytics],
  },
];

export const GA_GUIDES: Readonly<Record<string, GaGuide>> = Object.freeze(
  Object.fromEntries(GUIDES.map((guide) => [guide.id, guide])),
);

export function gaGuide(guideId: string): GaGuide | null {
  return Object.hasOwn(GA_GUIDES, guideId) ? (GA_GUIDES[guideId] ?? null) : null;
}
