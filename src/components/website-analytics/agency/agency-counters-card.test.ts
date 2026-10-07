import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GaAgencyCounters } from "@/server/website-analytics/agency/counters";

import { GaAgencyCountersCard } from "./agency-counters-card";

// Bu dosyanın kanıtladığı (GA-F8, /health): kart yalnız sayaçları gösterir,
// null sayaçta hiçbir şey çizmez, paylaşım ve anahtar bölümleri yalnız veri
// varken görünür ve mülk kimliği hiçbir yoldan karta girmez.

const PROPERTY_ID = "987654321";

const counters: GaAgencyCounters = {
  links: {
    main: 12,
    extra: 5,
    workspacesWithExtras: 3,
    extraHealthNotOk: 2,
    extraStale72h: 1,
  },
  shares: { active: 7, created7d: 4, viewed7d: 31, brandedWorkspaces: 2 },
  bigQuery: { pending: 1, ok: 3, error: 2, bytesThisMonth: 12_300_000_000 },
  funnels: { defined: 6, ran24h: 4, failed: 1 },
  risc: {
    received24h: 9,
    applied24h: 8,
    received30d: 40,
    recheck30d: 3,
    pending: 0,
  },
  keys: {
    currentKeyId: "k2",
    legacyRows: 4,
    currentRows: 20,
    otherRows: 1,
    totalRows: 25,
  },
};

const render = (value: GaAgencyCounters | null) =>
  renderToStaticMarkup(createElement(GaAgencyCountersCard, { counters: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("GaAgencyCountersCard", () => {
  it("renders nothing without counters", () => {
    expect(render(null)).toBe("");
  });

  it("shows every counter", () => {
    const html = text(render(counters));
    expect(html).toContain("Google Analytics agency");
    expect(html).toContain("Main properties 12");
    expect(html).toContain("Extra properties 5");
    expect(html).toContain("Workspaces with extras 3");
    expect(html).toContain("Extras not healthy 2");
    expect(html).toContain("Extras with data older than 72 h 1");
    expect(html).toContain("Client links (all reports)");
    expect(html).toContain("Active client links 7");
    expect(html).toContain("Links viewed, 7 days 31");
    expect(html).toContain("Branded workspaces 2");
    expect(html).toContain("Sources pending 1");
    expect(html).toContain("Sources failing 2");
    expect(html).toContain("Billed this month 12.3 GB");
    expect(html).toContain("Funnels defined 6");
    expect(html).toContain("Last run failed 1");
    expect(html).toContain("Received, 24 h 9");
    expect(html).toContain("Applied, 24 h 8");
    expect(html).toContain("Needs a recheck, 30 days 3");
    expect(html).toContain("Credentials on legacy key 4");
    expect(html).toContain("Counters only.");
  });

  it("leaves out the client links and key sections when there is no data", () => {
    const html = text(render({ ...counters, shares: null, keys: null }));
    expect(html).not.toContain("Client links");
    expect(html).not.toContain("Token keys");
    expect(html).toContain("BigQuery export");
  });

  it("never shows a property id, a name or an e-mail address", () => {
    const leaked = {
      ...counters,
      propertyId: PROPERTY_ID,
      email: "boss@agency.test",
    } as GaAgencyCounters;
    const html = render(leaked);
    expect(html).not.toContain(PROPERTY_ID);
    expect(html).not.toContain("boss@agency.test");
  });
});
