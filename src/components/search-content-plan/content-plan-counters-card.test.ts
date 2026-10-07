import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SeoContentPlanCounters } from "@/server/seo/content-plan/counters";

import { ContentPlanCountersCard } from "./content-plan-counters-card";

// Bu dosyanın kanıtladığı (SC-F7, /health): kart yalnız sayaçları gösterir,
// boş plan dökümünü nedene göre verir ve hiçbir yoldan proje kimliği ya da
// anahtar kelime girmez.

const counters: SeoContentPlanCounters = {
  plans30d: 11,
  empty30d: 4,
  byEmptyReason: { NO_GAPS: 3, AI_LIMIT: 1 },
  slotsPlanned: 22,
  slotsWritten: 9,
  slotsPublished: 5,
  slotsSkipped: 3,
  wordingBasic30d: 2,
  regenerations30d: 6,
  capBlocked30d: 7,
  projectsWithPlan: 8,
};

const render = (value: SeoContentPlanCounters) =>
  renderToStaticMarkup(
    createElement(ContentPlanCountersCard, { counters: value }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("ContentPlanCountersCard", () => {
  it("shows every counter", () => {
    const plain = text(render(counters));
    expect(plain).toContain("SEO content plan");
    expect(plain).toContain("Projects with a plan 8");
    expect(plain).toContain("Plans (30d) 11");
    expect(plain).toContain("Empty plans (30d) 4");
    expect(plain).toContain("Articles planned 22");
    expect(plain).toContain("Articles written 9");
    expect(plain).toContain("Articles published 5");
    expect(plain).toContain("Articles skipped 3");
    expect(plain).toContain("Basic wording (30d) 2");
    expect(plain).toContain("Refreshes (30d) 6");
    expect(plain).toContain("Blocked by limit (30d) 7");
    expect(plain).toContain("Counters only.");
  });

  it("breaks the empty plans down by reason", () => {
    const plain = text(render(counters));
    expect(plain).toContain("Empty plans by reason (30d)");
    expect(plain).toContain("No gaps 3");
    expect(plain).toContain("AI limit 1");
    expect(plain).not.toContain("Not enough data");
  });

  it("omits the breakdown when there is nothing to break down", () => {
    const plain = text(render({ ...counters, byEmptyReason: {} }));
    expect(plain).not.toContain("by reason");
  });

  it("never shows project ids, names or keywords", () => {
    const leaked = {
      ...counters,
      projectId: "project-secret-1",
      projectName: "Secret Shop",
      keyword: "secret keyword",
    };
    const html = render(leaked as unknown as SeoContentPlanCounters);
    expect(html).not.toContain("project-secret-1");
    expect(html).not.toContain("Secret Shop");
    expect(html).not.toContain("secret keyword");
  });
});
