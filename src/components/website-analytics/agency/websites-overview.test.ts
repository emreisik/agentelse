import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WebsitesOverviewRow } from "@/lib/website-analytics/agency/overview";

// SC-F9'un çerçevesi bu pakette yok: yalnız StatusDot'un sözleşmesi taklit edilir.
vi.mock("@/components/agency-overview/frame", () => ({
  StatusDot: ({ tone, label }: { tone: string; label: string }) =>
    createElement("span", { "data-tone": tone }, label),
}));

import { WebsitesOverviewList } from "./websites-overview";

// Bu dosyanın kanıtladığı (GA-F8, /websites): satırlar, dikkat sırasına göre
// verilen sırayla çizilir; yalnız mülk/proje adı ve sayılar görünür; ekstra
// mülkün bağı ?property= taşır; bayrak kapalıyken proje bağı yoktur; müşteri
// bağları yalnız ana satırda.

function row(over: Partial<WebsitesOverviewRow> = {}): WebsitesOverviewRow {
  return {
    linkId: "l1",
    projectId: "p1",
    projectName: "Acme",
    projectStatus: "ACTIVE",
    propertyId: "111",
    propertyName: "Acme web",
    role: "main",
    serviceLevel: "standard",
    currency: "USD",
    health: "OK",
    healthReason: null,
    connection: "ok",
    measurementScore: 92,
    dataThrough: new Date().toISOString().slice(0, 10),
    sessions7d: 1240,
    sessionsChangePct: 5.2,
    keyEvents7d: 31,
    keyEventsChangePct: -12.4,
    revenue7d: 1500,
    openFindings: 2,
    alertsCritical: 0,
    alertsWarn: 0,
    agentelseChanges: 0,
    bigQuery: "off",
    activeShares: 0,
    isMock: false,
    ...over,
  };
}

const render = (
  rows: WebsitesOverviewRow[],
  options: { truncated?: boolean; linkProjects?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(WebsitesOverviewList, {
      rows,
      truncated: options.truncated ?? false,
      linkProjects: options.linkProjects ?? true,
    }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("WebsitesOverviewList", () => {
  it("renders the numbers of a row", () => {
    const html = text(render([row()]));
    expect(html).toContain("All properties (1)");
    expect(html).toContain("Acme");
    expect(html).toContain("Acme web");
    expect(html).toContain("Main");
    expect(html).toContain("Sessions 7d 1,240 +5%");
    expect(html).toContain("Key events 7d 31 -12%");
    expect(html).toContain("Revenue 7d 1,500 USD");
    expect(html).toContain("Measurement score 92");
    expect(html).toContain("Open findings 2");
    expect(html).toContain("Alerts 0");
    expect(html).toContain("Healthy");
  });

  it("keeps the order it is given", () => {
    const html = render([
      row({ linkId: "a", projectName: "Zulu", connection: "needs_reconnect" }),
      row({ linkId: "b", projectName: "Alpha" }),
    ]);
    expect(html.indexOf("Zulu")).toBeLessThan(html.indexOf("Alpha"));
    expect(html).toContain('data-tone="bad"');
  });

  it("shows dashes where a property has no numbers", () => {
    const html = text(
      render([
        row({
          sessions7d: null,
          keyEvents7d: null,
          revenue7d: null,
          measurementScore: null,
          dataThrough: null,
        }),
      ]),
    );
    expect(html).toContain("Sessions 7d —");
    expect(html).toContain("Revenue 7d —");
    expect(html).toContain("Measurement score —");
    expect(html).toContain("No data yet");
  });

  it("links the main property to the site page and an extra with ?property=", () => {
    const html = render([
      row({ linkId: "m" }),
      row({ linkId: "x", role: "extra", propertyId: "222", propertyName: "Shop" }),
    ]);
    expect(html).toContain('href="/projects/p1/site"');
    expect(html).toContain('href="/projects/p1/site?property=222"');
    expect(text(html)).toContain("Extra");
  });

  it("renders plain text names when the site page is off", () => {
    const html = render([row()], { linkProjects: false });
    expect(html).not.toContain("<a ");
    expect(text(html)).toContain("Acme");
  });

  it("shows the client links on the main row only", () => {
    const html = text(
      render([
        row({ linkId: "m", activeShares: 3 }),
        row({ linkId: "x", role: "extra", activeShares: 3 }),
      ]),
    );
    expect(html.match(/Client links/g)).toHaveLength(1);
    expect(html).toContain("Client links 3");
    expect(text(render([row({ activeShares: 0 })]))).not.toContain("Client links");
  });

  it("shows Agentelse changes only when there are some", () => {
    expect(text(render([row({ agentelseChanges: 0 })]))).not.toContain("Changes by Agentelse");
    expect(text(render([row({ agentelseChanges: 4 })]))).toContain("Changes by Agentelse 4");
  });

  it("shows a BigQuery chip only when it is not off", () => {
    expect(text(render([row({ bigQuery: "off" })]))).not.toContain("BigQuery");
    expect(text(render([row({ bigQuery: "ok" })]))).toContain("BigQuery: ok");
    expect(text(render([row({ bigQuery: "error" })]))).toContain("BigQuery: needs a look");
  });

  it("shows the 360, demo and reconnect chips", () => {
    const html = text(
      render([row({ serviceLevel: "360", isMock: true, connection: "needs_reconnect" })]),
    );
    expect(html).toContain("360");
    expect(html).toContain("Demo");
    expect(html).toContain("Needs reconnect");
  });

  it("shows the truncated note and the empty state", () => {
    expect(text(render([row()], { truncated: true }))).toContain(
      "Showing the first 200 properties.",
    );
    expect(text(render([row()]))).not.toContain("Showing the first");
    expect(text(render([]))).toContain("No properties here yet");
  });

  it("shows no e-mail or health text from Google, only names and numbers", () => {
    const html = render([
      row({ healthReason: "owner@client.test lost access", health: "ACCESS_LOST" }),
    ]);
    expect(html).not.toContain("owner@client.test");
    expect(html).not.toContain("lost access");
  });
});
