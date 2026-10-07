import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SeoActionCounters } from "@/server/seo/actions/operator-counters";

import { SeoActionCountersCard } from "./seo-action-counters-card";

// Bu dosyanın kanıtladığı (SC-F6, /health): kart yalnız sayaçları gösterir,
// 30 günlük "No clear result" dökümünü nedene göre verir ve hiçbir yoldan
// proje adı, adres ya da sorgu girmez.

const counters: SeoActionCounters = {
  open: 7,
  awaitingVerification: 3,
  asked: 2,
  measuring: 4,
  evaluated30d: { worked: 5, didnt: 1, inconclusive: 6 },
  inconclusiveByReason30d: { LOW_DATA: 4, GOOGLE_UPDATE: 2 },
  expired30d: 1,
  learnings30d: 2,
};

const render = (value: SeoActionCounters) =>
  renderToStaticMarkup(
    createElement(SeoActionCountersCard, { counters: value }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("SeoActionCountersCard", () => {
  it("shows every counter", () => {
    const plain = text(render(counters));
    expect(plain).toContain("SEO actions");
    expect(plain).toContain("Open 7");
    expect(plain).toContain("Awaiting verification 3");
    expect(plain).toContain("Asked the user 2");
    expect(plain).toContain("Measuring 4");
    expect(plain).toContain("Worked (30d) 5");
    expect(plain).toContain("Didn't work (30d) 1");
    expect(plain).toContain("No clear result (30d) 6");
    expect(plain).toContain("Expired (30d) 1");
    expect(plain).toContain("Learnings (30d) 2");
    expect(plain).toContain("Counters only.");
  });

  it("breaks the inconclusive results down by reason", () => {
    const plain = text(render(counters));
    expect(plain).toContain("No clear result by reason (30d)");
    expect(plain).toContain("Low data 4");
    expect(plain).toContain("Google update 2");
    expect(plain).not.toContain("Overlapping change");
  });

  it("omits the breakdown when there is nothing to break down", () => {
    const plain = text(render({ ...counters, inconclusiveByReason30d: {} }));
    expect(plain).not.toContain("by reason");
  });

  it("never shows project names, addresses or queries", () => {
    const leaked = {
      ...counters,
      projectName: "Secret Shop",
      targetUrl: "https://secret.example.com/page",
      query: "secret query",
    };
    const html = render(leaked as unknown as SeoActionCounters);
    expect(html).not.toContain("Secret Shop");
    expect(html).not.toContain("secret.example.com");
    expect(html).not.toContain("secret query");
  });
});
