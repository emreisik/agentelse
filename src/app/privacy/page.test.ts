import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { default: PrivacyPage } = await import("./page");

// What this suite locks in: the Instagram section of the privacy policy says what the
// product really does (the claims were checked against the code in an independent
// review): content can also go out on a schedule or under Autopilot, Disconnect does not
// erase, the menu is called Connectors, and the Facebook route / Meta Ads are mentioned.

const html = renderToStaticMarkup(createElement(PrivacyPage));
const sectionBetween = (from: string, to: string) =>
  html.slice(html.indexOf(`id="${from}"`), html.indexOf(`id="${to}"`));
// Tags and entities out, so a sentence can be matched across inline markup.
const plain = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;|’/g, "'")
    .replace(/\s+/g, " ");
const section = sectionBetween("instagram-data", "facebook-and-meta-ads");
const text = plain(section);

describe("privacy policy: Instagram connection section", () => {
  it("carries the date of the latest rewrite (7 October 2026: the optional Google Analytics edit permission)", () => {
    expect(html).toContain("Last updated: October 7, 2026");
  });

  it("is titled for what it covers, and linked from the deletion page", () => {
    expect(section).toContain("Instagram connection");
    expect(section).not.toContain("Instagram and Meta connections");
  });

  it("names the three permissions requested", () => {
    expect(text).toContain("Agentelse asks for three");
    expect(text).toContain("instagram_business_basic");
    expect(text).toContain("instagram_business_content_publish");
    expect(text).toContain("instagram_business_manage_insights");
  });

  it("says the profile figures, post counters and insights are shown, not stored", () => {
    expect(text).toContain("last 28 days");
    expect(text).toContain("shown to you; we do not store them");
    expect(text).toContain(
      "We do not read your messages, the content of comments or who your followers are",
    );
  });

  it("does not say content only ever goes out after a click: scheduled posting and Autopilot publish too", () => {
    expect(text).toContain("scheduled posting or Autopilot");
    expect(text).not.toContain("only to publish content you approve");
    expect(text).not.toContain("Nothing is published without");
  });

  it("says Disconnect and removing the app stop use but do not erase the record, and how to erase it", () => {
    expect(text).toContain("Connectors > Instagram > Disconnect");
    expect(text).toContain(
      "Neither erases the stored connection record by itself",
    );
    expect(text).toContain("email us");
    expect(text).toContain("if Instagram offers the choice");
    expect(text).not.toContain("Integrations > Instagram");
  });

  it("covers the Facebook route and Meta Ads too, with where to remove that access", () => {
    expect(text).toContain("connect through a Facebook Page instead");
    expect(text).toContain("Meta Ads");
    expect(text).toContain("Business Integrations");
  });

  it("says recent posts are read only for a style analysis the person asks for, and not stored", () => {
    expect(text).toContain("the images and captions of its most recent posts");
    expect(text).toContain(
      "sent to our AI provider for that analysis and are not stored",
    );
  });

  it("says what is NOT done with the data", () => {
    expect(text).toContain(
      "do not read your messages, the content of comments",
    );
    expect(text).toContain("do not sell this data");
  });
});

// The Facebook Page and Meta Ads section names every permission those two
// connections request and says what each is used for, so the policy matches what
// Meta's reviewers see requested (meta-client.ts SCOPES).
describe("privacy policy: Facebook Page and Meta Ads section", () => {
  const meta = plain(
    sectionBetween(
      "facebook-and-meta-ads",
      "google-analytics-and-search-console",
    ),
  );

  it("names every permission the Facebook and Meta Ads connections request", () => {
    for (const permission of [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "business_management",
      "ads_management",
      "ads_read",
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
    ]) {
      expect(meta, permission).toContain(permission);
    }
  });

  it("lists what the callback and the shares store, and that the Meta grant is shared", () => {
    expect(meta).toContain("your name on Facebook");
    expect(meta).toContain("ids of posts Agentelse shared on your Page");
    expect(meta).toContain("names of your connected Page and accounts");
    expect(meta).toContain("one grant per person");
  });

  it("says Page posts can be edited and deleted, and are read back", () => {
    expect(meta).toContain("change the text of those posts or delete them");
    expect(meta).toContain("read back the posts Agentelse published there");
  });

  it("says AI may process campaign figures, and where each connection is removed", () => {
    expect(meta).toContain("processed by our AI provider");
    expect(meta).toContain("Connectors > Facebook > Disconnect");
    expect(meta).toContain("Connectors > Meta Ads > Disconnect");
    expect(meta).toContain("Neither erases the stored record by itself");
  });
});

// The Google section is what Google's OAuth verification reads: both read-only
// permissions with their purpose, the Limited Use disclosure in Google's own
// wording, and what Disconnect does (docs/google-analytics-plan.md §3.11).
describe("privacy policy: Google Analytics and Search Console section", () => {
  const google = plain(
    sectionBetween("google-analytics-and-search-console", "data-retention"),
  );

  it("names both read-only permissions and says the two connect separately", () => {
    expect(google).toContain("analytics.readonly");
    expect(google).toContain("webmasters.readonly");
    expect(google).toContain("two separate connections");
    expect(google).toContain(
      "Without that extra permission, Agentelse never changes anything in your Google accounts",
    );
  });

  it("carries the Limited Use disclosure", () => {
    expect(google).toContain(
      "Agentelse's use of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.",
    );
  });

  it("says what is not done with the data and who can read it", () => {
    expect(google).toContain("We do not sell this data");
    expect(google).toContain("we do not use it to train AI models");
    expect(google).toContain("People at Agentelse do not read it");
  });

  it("describes the optional Google Analytics edit permission (GA-F7)", () => {
    expect(google).toContain("Search Console is always read-only");
    expect(google).toContain("analytics.edit");
    expect(google).toContain("It is optional");
    expect(google).toContain("approves one by one");
    expect(google).toContain("so you can undo it");
    expect(google).toContain("up to 24 months");
    expect(google).toContain("deletes that record when you disconnect");
    expect(google).toContain("the history itself is not stored");
    expect(google).toContain("turn editing off at any time in Connectors");
    expect(google).toContain("Google Account settings");
  });

  it("describes extra properties, client report links, BigQuery and Cross-Account Protection (GA-F8)", () => {
    expect(google).toContain("more than one Google Analytics property");
    expect(google).toContain("client report link");
    expect(google).toContain("you revoke it");
    expect(google).toContain("BigQuery export");
    expect(google).toContain("Cross-Account Protection");
    expect(google).toContain("encrypts the stored Google tokens");
  });

  it("describes the Search Console BigQuery export, report links and their deletion (SC-F9)", () => {
    expect(google).toContain("bulk data export to BigQuery");
    expect(google).toContain("read-only service account");
    expect(google).toContain("your own Google Cloud project");
    expect(google).toContain("only the property owner can connect it");
    expect(google).toContain(
      "the link is deleted right away when you disconnect Search Console",
    );
    expect(google).toContain("split-test results");
  });

  it("says what the monthly SEO content plan stores and how it is removed (SC-F7)", () => {
    expect(google).toContain("monthly SEO content plan");
    expect(google).toContain(
      "drafts you have not started are removed from your calendar",
    );
  });

  it("says which Google Analytics summaries are kept, for how long, and masked", () => {
    expect(google).toContain("daily summaries");
    expect(google).toContain("up to 400 days");
    expect(google).toContain("never individual visitors");
    expect(google).toContain("are masked");
    expect(google).toContain("weekly summaries");
    expect(google).toContain("up to 36 months");
    expect(google).toContain("top 50 landing pages");
    expect(google).toContain("search words are masked");
    expect(google).toContain("are not stored");
    // GA-F3: ölçüm kontrolleri.
    expect(google).toContain("measurement checks");
    expect(google).toContain(
      "never the addresses or the personal details themselves",
    );
    expect(google).toContain("AgentelseSiteCheck");
    expect(google).toContain("robots.txt");
    expect(google).toContain("project's own Telegram");
  });

  it("says what the site audit fetches and stores", () => {
    expect(google).toContain("visits the public pages of that website only");
    expect(google).toContain("at most one request per second");
    expect(google).toContain("follows your robots.txt");
    expect(google).toContain("a copy of your robots.txt");
    expect(google).toContain("link text");
    expect(google).toContain("don't store the page text");
    expect(google).toContain("at most 200 checks a day");
    expect(google).toContain(
      "disconnecting Search Console deletes these right away",
    );
    expect(google).toContain(
      "short notice with no figures, pages or findings",
    );
    // Uyarılar Telegram'a da gidebilir: "yalnız size gösterilir" denmez
    // (GA-F4 bulguları için söylenir; onlar Telegram'a gitmez).
    expect(google).not.toMatch(/[Aa]lerts[^.]*shown only to you/);
    expect(google).toContain("DNS TXT record");
    expect(google).toContain("Chrome UX Report");
    expect(google).toContain("delete its data anytime");
  });

  it("says which Search Console summaries are kept, how long beyond Google's 16 months, and masked", () => {
    expect(google).toContain("For Google Search Console we also keep summaries");
    expect(google).toContain("including data older than the 16 months Google keeps");
    expect(google).toContain("weekly query and page summaries for 36 months");
    expect(google).toContain("keep only the last 16 months");
    expect(google).toContain("delete the stored history anytime");
    expect(google).toContain("deleted after 30 days");
    expect(google).toContain("Searches Google hides for privacy never reach us");
    expect(google).toContain("in search queries and addresses are masked");
  });

  it("says what the website insights keep and send to AI (GA-F4)", () => {
    expect(google).toContain("at the latest 24 months after they are closed");
    expect(google).toContain(
      "at most 20 masked page addresses or search words per request",
    );
  });

  it("says what the search opportunity engine keeps and sends to AI", () => {
    expect(google).toContain("finds search opportunities");
    expect(google).toContain("for up to 24 months or until you disconnect");
    expect(google).toContain("sent once to our AI provider");
    expect(google).toContain("never more than 20 at a time");
    expect(google).toContain("suggest spellings of your brand");
    expect(google).toContain(
      "deletes these opportunities, topic groups and suggestions right away",
    );
  });

  it("says what the website reports keep and delete (GA-F5)", () => {
    expect(google).toContain("keeps each report as it was sent");
    expect(google).toContain(
      "weekly reports, monthly reports and plans for 400 days",
    );
    expect(google).toContain(
      "these reports and the goal progress taken from it are deleted right away",
    );
  });

  it("says what link tracking adds, keeps and deletes (GA-F6)", () => {
    expect(google).toContain("standard tracking tags (UTM parameters)");
    expect(google).toContain(
      "until the project is deleted",
    );
    expect(google).toContain("You can turn link tracking off in Settings");
  });

  it("says Agentelse compares Search Console numbers before and after a change (SC-F6)", () => {
    expect(google).toContain(
      "compares your Search Console numbers before and after the change",
    );
  });

  it("says the SEO Manager sends a few masked search words and the page text to the AI provider (SC-F6)", () => {
    expect(google).toContain("top search words (personal details masked, at most 10)");
    expect(google).toContain("are not used to train AI models");
  });

  it("says how long the Search reports are kept (SC-F5)", () => {
    expect(google).toContain(
      "The weekly and monthly Search reports Agentelse writes from this data are kept for up to 36 months (16 months if you chose to keep only the last 16 months; daily notes for 90 days) and are deleted with it.",
    );
  });

  it("says Disconnect deletes right away and when Google access is kept", () => {
    expect(google).toContain(
      "deletes its stored token and the Google data in that connection right away",
    );
    expect(google).toContain(
      "unless the same Google account is still used by another of your Agentelse Google connections",
    );
    expect(google).toContain("Security > Third-party apps and services");
  });
});

describe("privacy policy: WordPress connection and website changes (SC-F8)", () => {
  const wordpress = plain(
    sectionBetween("wordpress-and-website-changes", "data-retention"),
  );

  it("says what is stored and that every change needs an owner or admin approval", () => {
    expect(wordpress).toContain("Application Password");
    expect(wordpress).toContain("approves each change");
    expect(wordpress).toContain("drafts");
  });

  it("says how long the copies are kept and when they are deleted", () => {
    expect(wordpress).toContain("up to 24 months");
    expect(wordpress).toContain(
      "deletes these copies when you disconnect WordPress",
    );
  });

  it("describes IndexNow and AI search visibility", () => {
    expect(wordpress).toContain("IndexNow");
    expect(wordpress).toContain("not Google");
    expect(wordpress).toContain(
      "without any Google Analytics or Search Console data",
    );
  });
});
