import type { SearchAlertKind } from "./alert-kinds";

// Arama sağlığı rehberleri (docs/search-health.md "Arayüz"): her uyarı türü
// için 3–6 adımlık İngilizce yol tarifi, ilgili ekran ve Google belgesi.
// Kullanıcı verisi ya da sayı içermez; bulgunun ayrıntısı uyarının kendi
// metnindedir.

export type SearchHealthGuide = {
  title: string;
  steps: string[];
  screen: string | null;
  learnMoreUrl: string | null;
};

const DOCS = "https://developers.google.com/search/docs";
const HELP = "https://support.google.com/webmasters/answer";

export const SEARCH_HEALTH_GUIDES: Readonly<
  Record<SearchAlertKind, SearchHealthGuide>
> = {
  GSC_SYNC_STALE: {
    title: "Search Console data stopped updating",
    steps: [
      "Open Integrations in Agentelse and check the Search Console connection.",
      "If it asks you to reconnect, reconnect with the Google account that owns the property.",
      "Make sure the property still exists in Search Console and that you still have access to it.",
      "Updates resume on their own once the connection works again.",
    ],
    screen: "Integrations > Google Search Console",
    learnMoreUrl: `${HELP}/7576553`,
  },
  GSC_SEARCH_DROP: {
    title: "Clicks from Google dropped",
    steps: [
      "Check the Index & technical health section for critical issues that started at the same time.",
      "Compare the drop with recent changes to your site, such as a redesign, new pages or removed pages.",
      "Look at the top pages and queries on the Search page to see where the clicks were lost.",
      "If a Google update overlaps the drop, review Google's guidance for that update before changing content.",
    ],
    screen: "Search",
    learnMoreUrl: `${DOCS}/monitor-debug/debugging-search-traffic-drops`,
  },
  SEO_KEY_PAGE_NOINDEX: {
    title: "A key page is set to noindex",
    steps: [
      "Open the page's HTML and look for a robots meta tag that contains noindex.",
      "Check your server or CDN settings for an X-Robots-Tag header that contains noindex.",
      "In your CMS, look for a setting such as 'Discourage search engines' or 'Hide from search' and turn it off.",
      "Remove the noindex, then use Inspect on this page so Google checks it again.",
    ],
    screen: "Search > Index & technical health > Key pages",
    learnMoreUrl: `${DOCS}/crawling-indexing/block-indexing`,
  },
  SEO_ROBOTS_BLOCK: {
    title: "robots.txt blocks search engines",
    steps: [
      "Open your robots.txt file at the root of your site.",
      "Look for Disallow rules that cover your whole site or your important pages, for Googlebot or for all crawlers.",
      "Remove or narrow those rules so search engines can reach your public pages.",
      "Publish the file and check it again in the robots.txt report in Search Console.",
    ],
    screen: "Search > Index & technical health > Sitemaps & robots",
    learnMoreUrl: `${DOCS}/crawling-indexing/robots/intro`,
  },
  SEO_ROBOTS_ERROR: {
    title: "robots.txt returns server errors",
    steps: [
      "Open your robots.txt file in a browser and check that it loads.",
      "Ask your host or developer why the server returns an error for it, including firewall or bot protection rules.",
      "Make sure robots.txt answers with a normal page or a not found page, never a server error.",
      "While robots.txt fails, Google may stop crawling your site, so fix this first.",
    ],
    screen: "Search > Index & technical health > Sitemaps & robots",
    learnMoreUrl: `${DOCS}/crawling-indexing/robots/robots_txt`,
  },
  SEO_ROBOTS_ASSETS: {
    title: "robots.txt blocks files search engines need",
    steps: [
      "Open your robots.txt file and find the Disallow rules that match your sitemap or your CSS and JavaScript files.",
      "Allow the sitemap and the files your homepage needs to render.",
      "Publish the file and check your homepage with the URL Inspection tool in Search Console.",
    ],
    screen: "Search > Index & technical health > Sitemaps & robots",
    learnMoreUrl: `${DOCS}/crawling-indexing/robots/intro`,
  },
  SEO_KEY_PAGE_ERROR: {
    title: "A key page is not loading",
    steps: [
      "Open the page in a private browser window and check whether it loads.",
      "If it shows an error, ask your host or developer to check the server, the CMS and any recent deploy.",
      "If the page moved, redirect the old address to the new page with a permanent redirect.",
      "Check your firewall or bot protection settings if the page loads for you but not for crawlers.",
    ],
    screen: "Search > Index & technical health > Key pages",
    learnMoreUrl: `${DOCS}/crawling-indexing/http-network-errors`,
  },
  GSC_CANONICAL_MISMATCH: {
    title: "Google picked a different canonical page",
    steps: [
      "Open the URL Inspection tool in Search Console for the page.",
      "Compare the canonical you declared with the one Google selected.",
      "Make sure duplicate pages point to one preferred page and your internal links use that address.",
      "Remove conflicting signals such as redirects or sitemap entries that point to a different version.",
    ],
    screen: "Search Console > URL Inspection",
    learnMoreUrl: `${DOCS}/crawling-indexing/consolidate-duplicate-urls`,
  },
  SEO_CANONICAL_OFFSITE: {
    title: "A key page points to another website",
    steps: [
      "Open the page's HTML and find the link rel canonical tag.",
      "Change it to the page's own address on your site.",
      "Check your CMS or SEO plugin settings, because a wrong site address there often causes this.",
      "Use Inspect on the page so Google sees the fix sooner.",
    ],
    screen: "Search > Index & technical health > Key pages",
    learnMoreUrl: `${DOCS}/crawling-indexing/consolidate-duplicate-urls`,
  },
  GSC_INDEX_LOST: {
    title: "A key page dropped out of Google's index",
    steps: [
      "Open the URL Inspection tool in Search Console for the page and read the reason.",
      "Fix what it reports, such as noindex, a redirect, a server error or a canonical to another page.",
      "Use Request indexing in Search Console once the page is fixed.",
      "Check again in a few days with Inspect in Agentelse.",
    ],
    screen: "Search Console > URL Inspection",
    learnMoreUrl: `${HELP}/9012289`,
  },
  GSC_NEW_PAGES_NOT_INDEXED: {
    title: "New pages are not getting indexed",
    steps: [
      "Check that the new pages are linked from your menu, category pages or other pages.",
      "Make sure each new page has unique, useful content and is not a near copy of another page.",
      "Keep the new pages in your sitemap and check them with the URL Inspection tool.",
      "Request indexing for the most important new pages in Search Console.",
    ],
    screen: "Search Console > Indexing > Pages",
    learnMoreUrl: `${DOCS}/crawling-indexing/ask-google-to-recrawl`,
  },
  GSC_COVERAGE_DROP: {
    title: "Fewer of your sitemap pages are indexed",
    steps: [
      "Open the Pages report in Search Console and look at the reasons pages are not indexed.",
      "Check the Index & technical health section for noindex, redirect or error issues.",
      "Remove pages from your sitemap that you do not want in Google.",
      "Improve or merge thin pages that Google chose not to index.",
    ],
    screen: "Search Console > Indexing > Pages",
    learnMoreUrl: `${HELP}/7440203`,
  },
  GSC_CRAWLED_NOT_INDEXED: {
    title: "Google crawls pages but does not index them",
    steps: [
      "Open the Pages report in Search Console and filter by 'Crawled - currently not indexed'.",
      "Look for pages that are thin, duplicated or very similar to each other.",
      "Improve the best pages, merge near duplicates and remove low value pages from the sitemap.",
      "Link to the improved pages from relevant pages on your site.",
    ],
    screen: "Search Console > Indexing > Pages",
    learnMoreUrl: `${HELP}/7440203`,
  },
  GSC_SITEMAP_ERRORS: {
    title: "Search Console reports sitemap problems",
    steps: [
      "Open the Sitemaps report in Search Console and select the sitemap.",
      "Read the errors and fix the sitemap file, or the plugin that creates it.",
      "Make sure the sitemap loads in a browser and only lists live pages of your site.",
      "Submit the sitemap again in Search Console after fixing it.",
    ],
    screen: "Search Console > Indexing > Sitemaps",
    learnMoreUrl: `${HELP}/7451001`,
  },
  SEO_SITEMAP_MISSING: {
    title: "Your sitemap could not be read",
    steps: [
      "Open your sitemap address in a browser and check that it loads.",
      "If you have no sitemap, turn one on in your CMS or SEO plugin.",
      "Add a Sitemap line with the full address to your robots.txt file.",
      "Submit the sitemap in Search Console.",
    ],
    screen: "Search > Index & technical health > Sitemaps & robots",
    learnMoreUrl: `${DOCS}/crawling-indexing/sitemaps/overview`,
  },
  SEO_SITEMAP_HYGIENE: {
    title: "The sitemap lists pages that should not be there",
    steps: [
      "Open the issue list to see which sitemap pages redirect, fail or are set to noindex.",
      "Remove those pages from the sitemap, or fix them if they should be indexed.",
      "List only the final, canonical address of each page.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/crawling-indexing/sitemaps/build-sitemap`,
  },
  GSC_STALE_CRAWL: {
    title: "Google has not crawled a key page for a long time",
    steps: [
      "Check that the page is linked from your homepage or main menu.",
      "Update the page and keep it in your sitemap with an accurate last modified date.",
      "Request indexing for the page in Search Console.",
    ],
    screen: "Search Console > URL Inspection",
    learnMoreUrl: `${DOCS}/crawling-indexing/ask-google-to-recrawl`,
  },
  SEO_STRUCTURED_DATA: {
    title: "Structured data on a key page has errors",
    steps: [
      "Open the issue list to see which structured data block has a problem.",
      "Fix the JSON so it is valid and includes the required properties.",
      "Test the page with the Rich Results Test.",
    ],
    screen: "Search > Index & technical health > Key pages",
    learnMoreUrl: `${DOCS}/appearance/structured-data/intro-structured-data`,
  },
  GSC_RICH_RESULTS: {
    title: "Google found rich result errors",
    steps: [
      "Open the Enhancements reports in Search Console.",
      "Select the item type with errors and read the affected pages.",
      "Fix the structured data and use Validate fix in Search Console.",
    ],
    screen: "Search Console > Enhancements",
    learnMoreUrl: `${HELP}/7552505`,
  },
  SEO_CWV_POOR: {
    title: "Page speed for real visitors needs work",
    steps: [
      "Open the Core Web Vitals report in Search Console to see which pages are slow.",
      "Compress and resize large images, and load images below the fold lazily.",
      "Remove scripts and plugins you do not need, and delay the rest.",
      "Check the pages again with PageSpeed Insights after the changes.",
    ],
    screen: "Search Console > Experience > Core Web Vitals",
    learnMoreUrl: `${DOCS}/appearance/core-web-vitals`,
  },
  SEO_HTTPS: {
    title: "Some pages are not fully secure",
    steps: [
      "Make sure every http address redirects to the https version.",
      "Update links, images and scripts that still use http addresses.",
      "Turn on HTTPS redirects in your host or CDN settings.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${HELP}/6073543`,
  },
  SEO_REDIRECT_CHAINS: {
    title: "Internal links go through redirect chains",
    steps: [
      "Open the issue list to see which pages redirect several times.",
      "Point each redirect straight to the final page.",
      "Update your internal links to use the final address.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/crawling-indexing/301-redirects`,
  },
  SEO_BROKEN_LINKS: {
    title: "The site has broken internal links",
    steps: [
      "Open the issue list to see which pages link to missing pages.",
      "Update each link to a page that exists, or remove it.",
      "If a page moved, redirect the old address to the new one.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/crawling-indexing/http-network-errors`,
  },
  SEO_ORPHAN_PAGES: {
    title: "Some pages have no internal links",
    steps: [
      "Open the issue list to see which pages nothing links to.",
      "Link to the pages you want found from related pages, menus or category pages.",
      "Remove or redirect pages you no longer need.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/crawling-indexing/links-crawlable`,
  },
  GSC_ORPHAN_PAGES: {
    title: "Pages that get search clicks have no internal links",
    steps: [
      "Open the issue to see which pages get clicks from Google but are not linked from your site.",
      "Add links to them from related pages or your menu so visitors and crawlers can find them.",
      "If a page is outdated, update it or redirect it to its replacement.",
    ],
    screen: "Search > Index & technical health",
    learnMoreUrl: `${DOCS}/crawling-indexing/links-crawlable`,
  },
  SEO_TITLES_META: {
    title: "Titles or descriptions need work",
    steps: [
      "Open the issue list to see pages with missing, duplicate or very short titles and descriptions.",
      "Write a unique title for each page that says what the page is about.",
      "Add a short, unique meta description that invites the click.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/appearance/title-link`,
  },
  SEO_HREFLANG: {
    title: "Language versions are set up incorrectly",
    steps: [
      "Open the issue list to see which hreflang links are wrong.",
      "Use valid language and region codes, such as en or en-GB.",
      "Make sure each language version links back to the others.",
      "Point hreflang only to pages that are their own canonical.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/specialty/international/localized-versions`,
  },
  SEO_RENDER_RISK: {
    title: "A key page may show little content to search engines",
    steps: [
      "Open the page with JavaScript turned off and see how much text is left.",
      "Render the main content on the server, or pre-render the page.",
      "Check the rendered page with the URL Inspection tool in Search Console.",
    ],
    screen: "Search Console > URL Inspection",
    learnMoreUrl: `${DOCS}/crawling-indexing/javascript/javascript-seo-basics`,
  },
  GSC_UPDATE_OVERLAP: {
    title: "A Google update overlaps the change",
    steps: [
      "Read what Google says the update is about before changing pages.",
      "Wait for the update to finish rolling out, then compare clicks again.",
      "Focus on helpful, original content instead of quick fixes.",
    ],
    screen: "Search",
    learnMoreUrl: "https://developers.google.com/search/updates/ranking",
  },
  GSC_SITE_MISMATCH: {
    title: "The Search Console property does not match your domain",
    steps: [
      "Open Integrations and check which Search Console property is selected.",
      "Pick the property that covers your project's domain, or add one in Search Console.",
      "Check the domain in your project settings.",
    ],
    screen: "Integrations > Google Search Console",
    learnMoreUrl: `${HELP}/34592`,
  },
  GSC_CONNECTION: {
    title: "The Search Console connection needs attention",
    steps: [
      "Open Integrations in Agentelse.",
      "Reconnect Search Console with the Google account that has access to the property.",
      "Allow Agentelse to read Search Console when Google asks.",
      "If the property was removed, add it again in Search Console or pick another property.",
    ],
    screen: "Integrations > Google Search Console",
    learnMoreUrl: `${HELP}/7687615`,
  },
  SEO_AI_CRAWLERS_BLOCKED: {
    title: "AI search crawlers are blocked",
    steps: [
      "Open your robots.txt file and find the rules for AI search crawlers such as OAI-SearchBot or PerplexityBot.",
      "Decide whether you want your pages to appear in AI search answers.",
      "If you do, remove the Disallow rules for those crawlers. Training crawlers can stay blocked.",
    ],
    screen: "Search > Index & technical health > Sitemaps & robots",
    learnMoreUrl: `${DOCS}/crawling-indexing/robots/intro`,
  },
  GSC_LOST_URLS: {
    title: "Pages that used to get clicks are lost",
    steps: [
      "Open the redirect map in this issue. It lists old addresses that now fail, redirect to an unrelated page or are set to noindex.",
      "For each old address, check the suggested new page and change it if a better match exists.",
      "Copy the map and add it to your host, CMS or redirect plugin as permanent (301) redirects.",
      "Restore pages that were removed by mistake instead of redirecting them.",
      "Check the old addresses again after the redirects are live.",
    ],
    screen: "Search > Index & technical health > Redirect map",
    learnMoreUrl: `${DOCS}/crawling-indexing/301-redirects`,
  },
  SEO_SITE_MIGRATION: {
    title: "Many page addresses changed",
    steps: [
      "Check whether the site was moved or redesigned recently.",
      "Redirect every old address to its new page with a permanent redirect.",
      "Update internal links and the sitemap to the new addresses.",
      "Watch the Pages report in Search Console for the next weeks.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: `${DOCS}/crawling-indexing/site-move-with-url-changes`,
  },
  SEO_CRAWL_BLOCKED: {
    title: "The site blocks our site audit",
    steps: [
      "Check your firewall or bot protection settings (for example Cloudflare) for blocked requests from AgentelseSiteAudit.",
      "Allow AgentelseSiteAudit, or lower the protection level for it.",
      "Use Check again now in the Site audit card once it is allowed.",
    ],
    screen: "Search > Index & technical health > Site audit",
    learnMoreUrl: null,
  },
};

const FALLBACK_GUIDE: SearchHealthGuide = {
  title: "Search health check",
  steps: [
    "Open the Index & technical health section on the Search page.",
    "Read the issue details and follow the suggested fix.",
    "Check again after making the change.",
  ],
  screen: "Search > Index & technical health",
  learnMoreUrl: null,
};

export function guideFor(kind: string): SearchHealthGuide {
  return Object.prototype.hasOwnProperty.call(SEARCH_HEALTH_GUIDES, kind)
    ? SEARCH_HEALTH_GUIDES[kind as SearchAlertKind]
    : FALLBACK_GUIDE;
}
