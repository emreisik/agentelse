import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GaInsightsOperatorView } from "@/lib/website-analytics/analysis/view-types";

import { GaInsightsOperatorCard } from "./ga-insights-operator-card";

// Bu dosyanın kanıtladığı (GA-F4, /health): kart yalnız sayaçları, proje
// adını ve genel başlığı gösterir; konu, yol ya da açıklama beklenmedik bir
// alanla gelse bile görünmez; incelenen yokken "—"; Review bağlantısının
// biçimi; boş liste metni.

const PATH = "/secret-landing-page";
const EXPLANATION = "Revenue fell because checkout broke";

const base: GaInsightsOperatorView = {
  mode: "shadow",
  counters: {
    openShadow: 14,
    openLive: 0,
    createdLast7d: 6,
    reviewable: 9,
    reviewed: 12,
    useful: 9,
    notUseful: 3,
    precision: 0.75,
    linksAnalyzed: 4,
    linksDue: 1,
    lastRunMinutesAgo: 17,
    byRule: [
      { ruleKey: "AN3", open: 5 },
      { ruleKey: "AN9", open: 0 },
    ],
  },
  recent: [
    {
      id: "f1",
      projectId: "proj-1",
      projectName: "Agentelse",
      ruleKey: "AN3",
      kind: "OPPORTUNITY",
      confidence: "DIRECTIONAL",
      mode: "shadow",
      createdAt: "2026-10-06T08:00:00.000Z",
      verdict: "USEFUL",
    },
  ],
};

const render = (value: GaInsightsOperatorView) =>
  renderToStaticMarkup(createElement(GaInsightsOperatorCard, { view: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("GaInsightsOperatorCard", () => {
  it("shows the mode, counters and per-rule chips", () => {
    const body = text(render(base));
    expect(body).toContain("Website insights (Google Analytics)");
    expect(body).toContain("Shadow");
    expect(body).toContain("Open (shadow) 14");
    expect(body).toContain("Open (live) 0");
    expect(body).toContain("New in 7 days 6");
    expect(body).toContain(
      "Reviewable 9 Open findings in projects you can open",
    );
    expect(body).toContain("Reviewed 12");
    expect(body).toContain("Useful % 75% Target ≥ 70% on 30 reviewed");
    expect(body).toContain("Links analyzed 4");
    expect(body).toContain("Links due 1");
    expect(body).toContain("Last run 17 min ago");
    expect(body).toContain("AN3 · 5");
    expect(body).not.toContain("AN9 ·");
  });

  it("links each recent finding to the review mode", () => {
    const html = render(base);
    expect(html).toContain(
      'href="/projects/proj-1/site?insights=review#finding-f1"',
    );
    const body = text(html);
    expect(body).toContain("Agentelse");
    expect(body).toContain("Landing page conversion");
    expect(body).toContain("Directional");
    expect(body).toContain("Useful");
    expect(body).toContain("Review");
  });

  it("shows — before anything is reviewed", () => {
    const body = text(
      render({
        ...base,
        counters: { ...base.counters, reviewed: 0, useful: 0, precision: null },
      }),
    );
    expect(body).toContain("Useful % —");
  });

  it("drops the target hint from 30 reviews", () => {
    const body = text(
      render({ ...base, counters: { ...base.counters, reviewed: 30 } }),
    );
    expect(body).not.toContain("Target ≥ 70%");
  });

  it("shows the empty recent state", () => {
    const body = text(render({ ...base, mode: "on", recent: [] }));
    expect(body).toContain(
      "No findings in your projects yet. Join a project's workspace to review its findings.",
    );
    expect(body).toContain("On");
  });

  it("never shows a subject, path or explanation", () => {
    const leaked = {
      ...base,
      subject: `page:${PATH}`,
      recent: base.recent.map((item) => ({
        ...item,
        subject: `page:${PATH}`,
        subjectLabel: PATH,
        explanation: EXPLANATION,
        evidence: { page: PATH },
      })),
    } as GaInsightsOperatorView;
    const html = render(leaked);
    expect(html).not.toContain(PATH);
    expect(html).not.toContain(EXPLANATION);
  });
});
