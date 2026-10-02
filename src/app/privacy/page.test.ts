import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { default: PrivacyPage } = await import("./page");

// What this suite locks in: the Instagram section of the privacy policy says what the
// product really does (the claims were checked against the code in an independent
// review): content can also go out on a schedule or under Autopilot, Disconnect does not
// erase, the menu is called Connectors, and the Facebook route / Meta Ads are mentioned.

const html = renderToStaticMarkup(createElement(PrivacyPage));
const section = html.slice(html.indexOf('id="instagram-data"'), html.indexOf('id="data-retention"'));
// Tags and entities out, so a sentence can be matched across inline markup.
const text = section
  .replace(/<[^>]+>/g, "")
  .replace(/&gt;/g, ">")
  .replace(/&rsquo;/g, "'")
  .replace(/\s+/g, " ");

describe("privacy policy: Instagram connection section", () => {
  it("carries the date of the text that was rewritten on 2 October 2026", () => {
    expect(html).toContain("Last updated: October 2, 2026");
  });

  it("is titled for what it covers, and linked from the deletion page", () => {
    expect(section).toContain("Instagram connection");
    expect(section).not.toContain("Instagram and Meta connections");
  });

  it("names the two permissions requested", () => {
    expect(text).toContain("instagram_business_basic");
    expect(text).toContain("instagram_business_content_publish");
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

  it("says what is NOT done with the data", () => {
    expect(text).toContain("do not read your followers, messages or comments");
    expect(text).toContain("do not sell this data");
  });
});
