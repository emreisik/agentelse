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
    .replace(/&rsquo;/g, "'")
    .replace(/\s+/g, " ");
const section = sectionBetween("instagram-data", "facebook-and-meta-ads");
const text = plain(section);

describe("privacy policy: Instagram connection section", () => {
  it("carries the date of the text that was rewritten on 2 October 2026", () => {
    expect(html).toContain("Last updated: October 2, 2026");
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
    expect(text).toContain("We do not read your messages, the content of comments or who your followers are");
  });

  it("does not say content only ever goes out after a click: scheduled posting and Autopilot publish too", () => {
    expect(text).toContain("scheduled posting or Autopilot");
    expect(text).not.toContain("only to publish content you approve");
    expect(text).not.toContain("Nothing is published without");
  });

  it("says Disconnect and removing the app stop use but do not erase the record, and how to erase it", () => {
    expect(text).toContain("Connectors > Instagram > Disconnect");
    expect(text).toContain("Neither erases the stored connection record by itself");
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
    expect(text).toContain("sent to our AI provider for that analysis and are not stored");
  });

  it("says what is NOT done with the data", () => {
    expect(text).toContain("do not read your messages, the content of comments");
    expect(text).toContain("do not sell this data");
  });
});

// The Facebook Page and Meta Ads section names every permission those two
// connections request and says what each is used for, so the policy matches what
// Meta's reviewers see requested (meta-client.ts SCOPES).
describe("privacy policy: Facebook Page and Meta Ads section", () => {
  const meta = plain(sectionBetween("facebook-and-meta-ads", "data-retention"));

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
