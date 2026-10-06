import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { scopeFromVerifiedDomain, type CrawlScope } from "@/lib/seo/crawl-url";

import { Frontier, parseFrontier, seedFrontier } from "./frontier";

// Bu dosyanın kanıtladığı: tohum sırası (ana sayfa, kilit sayfalar, GSC,
// sitemap), urlHash'e göre tekilleştirme, derinlik sonra ekleme sırası,
// kapasite ve taşma sayacı, izleme parametrelerinin tek adrese inmesi, eş
// alan adının kuyruğa girmemesi ve 512 karakteri aşan adreslerin sayılması.

const scope = scopeFromVerifiedDomain("example.com") as CrawlScope;
const ORIGIN = "example.com";

function drain(frontier: Frontier): string[] {
  const urls: string[] = [];
  for (let item = frontier.pop(); item; item = frontier.pop())
    urls.push(item.u);
  return urls;
}

describe("Frontier", () => {
  it("seeds in order: homepage, key pages, GSC pages, sitemap URLs", () => {
    const frontier = new Frontier(scope, ORIGIN);
    seedFrontier(frontier, {
      homeUrl: "https://example.com/",
      keyPages: ["https://example.com/", "https://example.com/pricing"],
      gscUrls: [
        "https://example.com/blog/[masked]",
        "https://example.com/gsc-page",
      ],
      sitemapUrls: [
        "https://example.com/sitemap-page",
        "https://example.com/pricing",
      ],
    });
    expect(drain(frontier)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/gsc-page",
      "https://example.com/sitemap-page",
    ]);
  });

  it("dedupes by URL hash and collapses tracking parameters", () => {
    const frontier = new Frontier(scope, ORIGIN);
    expect(frontier.add("https://example.com/a?utm_source=x", 1, "CRAWL")).toBe(
      "added",
    );
    expect(
      frontier.add("https://example.com/a?gclid=1&fbclid=2", 1, "CRAWL"),
    ).toBe("seen");
    expect(frontier.add("https://EXAMPLE.com/a#top", 2, "CRAWL")).toBe("seen");
    expect(drain(frontier)).toEqual(["https://example.com/a"]);
  });

  it("pops by depth, then insertion order", () => {
    const frontier = new Frontier(scope, ORIGIN);
    frontier.add("https://example.com/deep", 3, "CRAWL");
    frontier.add("https://example.com/one-a", 1, "CRAWL");
    frontier.add("https://example.com/", 0, "SEED");
    frontier.add("https://example.com/one-b", 1, "CRAWL");
    frontier.add("https://example.com/two", 2, "CRAWL");
    expect(drain(frontier)).toEqual([
      "https://example.com/",
      "https://example.com/one-a",
      "https://example.com/one-b",
      "https://example.com/two",
      "https://example.com/deep",
    ]);
  });

  it("caps the queue and counts dropped URLs once", () => {
    const frontier = new Frontier(scope, ORIGIN, 3);
    for (let index = 0; index < 5; index += 1) {
      frontier.add(`https://example.com/p${index}`, 1, "CRAWL");
    }
    frontier.add("https://example.com/p4", 1, "CRAWL");
    expect(frontier.size).toBe(3);
    expect(frontier.stats.droppedFrontier).toBe(2);
  });

  it("does not enqueue the twin host or other hosts", () => {
    const frontier = new Frontier(scope, ORIGIN);
    expect(frontier.add("https://www.example.com/about", 1, "CRAWL")).toBe(
      "other_host",
    );
    expect(frontier.add("https://www.example.com/about", 1, "CRAWL")).toBe(
      "other_host",
    );
    expect(frontier.add("https://other.com/x", 1, "CRAWL")).toBe(
      "out_of_scope",
    );
    expect(frontier.size).toBe(0);
    expect(frontier.stats.otherHosts).toBe(1);
    expect(frontier.stats.outOfScope).toBe(1);
  });

  it("counts URLs over 512 characters without storing them", () => {
    const frontier = new Frontier(scope, ORIGIN);
    const long = `https://example.com/${"a".repeat(600)}`;
    expect(frontier.add(long, 1, "CRAWL")).toBe("long");
    expect(frontier.size).toBe(0);
    expect(frontier.stats.longUrls).toBe(1);
  });

  it("restores a saved queue without the pages fetched in this crawl", () => {
    const frontier = new Frontier(scope, ORIGIN);
    frontier.add("https://example.com/", 0, "SEED");
    frontier.add("https://example.com/a", 1, "CRAWL");
    frontier.add("https://example.com/b", 1, "GSC");
    const first = frontier.pop();
    const saved = parseFrontier(frontier.toState());
    expect(saved).toEqual([
      { u: "https://example.com/a", d: 1, s: "CRAWL" },
      { u: "https://example.com/b", d: 1, s: "GSC" },
    ]);
    const restored = Frontier.restore(scope, ORIGIN, saved, []);
    expect(restored.add(first!.u, 1, "CRAWL")).toBe("added");
    expect(restored.add("https://example.com/a", 2, "CRAWL")).toBe("seen");
    expect(drain(restored)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/",
    ]);
  });

  it("puts a throttled item back at the front", () => {
    const frontier = new Frontier(scope, ORIGIN);
    frontier.add("https://example.com/a", 1, "CRAWL");
    frontier.add("https://example.com/b", 1, "CRAWL");
    const item = frontier.pop()!;
    frontier.requeue(item);
    expect(drain(frontier)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});
