import { describe, expect, it } from "vitest";

import { parseRobotsTxt } from "@/lib/seo/robots-parser";

import { allBlockedByWildcard, crawlerRows, searchBlocked, trainingBlocked } from "./crawlers";

// Bu dosyanın kanıtladığı (SC-F8 GEO2, GEO3): gerçek robots ayrıştırıcısıyla
// joker "Disallow: /", belirli bir AI tarayıcısının engeli ve allow ezmesi.

const SEARCH = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
];

describe("crawlerRows", () => {
  it("allows everything without a robots.txt", () => {
    const rows = crawlerRows(null);
    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row.allowed)).toBe(true);
    expect(searchBlocked(rows)).toEqual([]);
    expect(allBlockedByWildcard(null)).toBe(false);
  });

  it("blocks everyone through a wildcard Disallow all", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /\n");
    const rows = crawlerRows(robots);
    expect(rows.every((row) => !row.allowed)).toBe(true);
    expect(searchBlocked(rows).sort()).toEqual([...SEARCH].sort());
    expect(trainingBlocked(rows)).toHaveLength(6);
    expect(allBlockedByWildcard(robots)).toBe(true);
  });

  it("blocks only a specific training crawler", () => {
    const robots = parseRobotsTxt("User-agent: GPTBot\nDisallow: /\n");
    const rows = crawlerRows(robots);
    expect(trainingBlocked(rows)).toEqual(["GPTBot"]);
    expect(searchBlocked(rows)).toEqual([]);
    expect(allBlockedByWildcard(robots)).toBe(false);
  });

  it("lets a specific allow group override the wildcard block", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /\n\nUser-agent: PerplexityBot\nUser-agent: OAI-SearchBot\nAllow: /\n",
    );
    const rows = crawlerRows(robots);
    const blocked = searchBlocked(rows);
    expect(blocked).not.toContain("PerplexityBot");
    expect(blocked).not.toContain("OAI-SearchBot");
    expect(blocked).toContain("ChatGPT-User");
  });

  it("keeps a partial Disallow from blocking the homepage", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /private/\n");
    expect(searchBlocked(crawlerRows(robots))).toEqual([]);
    expect(allBlockedByWildcard(robots)).toBe(false);
  });

  it("takes the owner and purpose from the shared list", () => {
    const row = crawlerRows(null).find((entry) => entry.token === "Claude-SearchBot");
    expect(row).toMatchObject({ owner: "Anthropic", purpose: "search" });
  });
});
