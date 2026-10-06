import { describe, expect, it } from "vitest";

import {
  AI_CRAWLERS,
  aiCrawlerAccess,
  groupFor,
  isAllowed,
  isAllowedInGroup,
  parseRobotsTxt,
  robotsDiff,
  robotsPatternMatches,
  robotsTextHash,
  robotsVerdictForStatus,
  starGroup,
} from "./robots-parser";

// Bu dosyanın kanıtladığı: Google'ın belgelenmiş örnekleri (en uzak eşleşme,
// eşitlikte allow, "*" ve "$", %-kodlama), grup birleştirme ve belirteç
// eşleşmesi, "*" grubunun tek başına denetimi, sınırlar ve kötü niyetli
// desenlerin sınırlı sürede bittiği.

function allowed(text: string, path: string, token = "Googlebot"): boolean {
  return isAllowed(parseRobotsTxt(text), token, path).allowed;
}

describe("Google matching examples", () => {
  it("longest match wins, allow wins a tie", () => {
    const robots = "User-agent: *\nAllow: /p\nDisallow: /\n";
    expect(allowed(robots, "/page")).toBe(true);
    expect(allowed(robots, "/other")).toBe(false);
    const folder = "User-agent: *\nAllow: /folder\nDisallow: /folder\n";
    expect(allowed(folder, "/folder/page")).toBe(true);
    const html = "User-agent: *\nAllow: /page\nDisallow: /*.html\n";
    expect(allowed(html, "/page.html")).toBe(false);
    const php = "User-agent: *\nAllow: /$\nDisallow: /\n";
    expect(allowed(php, "/")).toBe(true);
    expect(allowed(php, "/page.htm")).toBe(false);
  });

  it("'*' matches any run and '$' anchors the end", () => {
    expect(robotsPatternMatches("/fish*", "/fish.html")).toBe(true);
    expect(robotsPatternMatches("/fish*", "/Fish.asp")).toBe(false);
    expect(
      robotsPatternMatches("/*.php", "/folder/filename.php?parameters"),
    ).toBe(true);
    expect(robotsPatternMatches("/*.php$", "/filename.php")).toBe(true);
    expect(robotsPatternMatches("/*.php$", "/filename.php?parameters")).toBe(
      false,
    );
    expect(robotsPatternMatches("/fish*.php", "/fishheads/catfish.php?p")).toBe(
      true,
    );
    expect(robotsPatternMatches("/fish/", "/fish")).toBe(false);
    expect(robotsPatternMatches("/fish", "/fish/salmon.htm")).toBe(true);
    expect(robotsPatternMatches("/", "/anything")).toBe(true);
    expect(robotsPatternMatches("/a$b", "/a$b")).toBe(true);
  });

  it("matches the query string and normalises percent-encoding", () => {
    const robots =
      "User-agent: *\nDisallow: /search?q=\nDisallow: /%7euser/\nDisallow: /ürün\n";
    expect(allowed(robots, "/search?q=shoes")).toBe(false);
    expect(allowed(robots, "/search")).toBe(true);
    expect(allowed(robots, "/~user/a")).toBe(false);
    expect(allowed(robots, "https://x.com/%7Euser/a")).toBe(false);
    expect(allowed(robots, "/%C3%BCr%C3%BCn/1")).toBe(false);
    expect(allowed(robots, "https://x.com/%c3%bcr%c3%bcn")).toBe(false);
  });

  it("'/robots.txt' is always allowed and null robots allows everything", () => {
    expect(allowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
    expect(isAllowed(null, "Googlebot", "/x")).toEqual({
      allowed: true,
      rule: null,
    });
  });

  it("returns the deciding rule", () => {
    const result = isAllowed(
      parseRobotsTxt("User-agent: *\nDisallow: /private\n"),
      "x",
      "/private/a",
    );
    expect(result).toEqual({
      allowed: false,
      rule: { allow: false, pattern: "/private" },
    });
  });
});

describe("parseRobotsTxt", () => {
  it("merges consecutive user-agent lines into one group", () => {
    const robots = parseRobotsTxt(
      "User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow: /y\n",
    );
    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0]?.agents).toEqual(["a", "b"]);
    expect(robots.groups[1]?.agents).toEqual(["c"]);
  });

  it("merges every group naming the token and matches the product token only", () => {
    const text = [
      "User-agent: googlebot",
      "Disallow: /a",
      "User-agent: *",
      "Disallow: /b",
      "User-agent: Googlebot/2.1",
      "Disallow: /c",
    ].join("\n");
    const robots = parseRobotsTxt(text);
    const group = groupFor(robots, "Googlebot");
    expect(group?.rules.map((rule) => rule.pattern)).toEqual(["/a", "/c"]);
    // Googlebot-Image adı geçmediği için "*" grubuna düşer.
    expect(
      groupFor(robots, "Googlebot-Image")?.rules.map((rule) => rule.pattern),
    ).toEqual(["/b"]);
    expect(
      groupFor(parseRobotsTxt("User-agent: x\nDisallow: /\n"), "Googlebot"),
    ).toBeNull();
  });

  it("starGroup checks '*' on its own next to a permissive Googlebot group", () => {
    const robots = parseRobotsTxt(
      "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n",
    );
    expect(isAllowed(robots, "Googlebot", "/").allowed).toBe(true);
    expect(isAllowedInGroup(starGroup(robots), "/").allowed).toBe(false);
    expect(isAllowedInGroup(null, "/").allowed).toBe(true);
  });

  it("ignores rules before any user-agent and empty disallow", () => {
    const robots = parseRobotsTxt("Disallow: /\nUser-agent: *\nDisallow:\n");
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.rules).toEqual([]);
    expect(isAllowed(robots, "Googlebot", "/x").allowed).toBe(true);
  });

  it("handles BOM, CRLF, comments, case-insensitive keys and invalid lines", () => {
    const robots = parseRobotsTxt(
      "﻿USER-AGENT: *   # all\r\nDISALLOW: /tmp # temp\r\nthis line is junk\r\nSitemap: https://x.com/s.xml\r\n",
    );
    expect(robots.groups[0]?.agents).toEqual(["*"]);
    expect(robots.groups[0]?.rules).toEqual([
      { allow: false, pattern: "/tmp" },
    ]);
    expect(robots.invalidLines).toBe(1);
    expect(robots.sitemaps).toEqual(["https://x.com/s.xml"]);
  });

  it("collects sitemaps globally, even before a user-agent", () => {
    const robots = parseRobotsTxt(
      "Sitemap: https://x.com/a.xml\nUser-agent: *\nSitemap: https://x.com/b.xml\nDisallow: /p\n",
    );
    expect(robots.sitemaps).toEqual([
      "https://x.com/a.xml",
      "https://x.com/b.xml",
    ]);
    expect(robots.groups[0]?.rules).toHaveLength(1);
  });

  it("converts crawl-delay to ms and caps it at 10 s", () => {
    expect(
      parseRobotsTxt("User-agent: *\nCrawl-delay: 2.5\n").groups[0]
        ?.crawlDelayMs,
    ).toBe(2500);
    expect(
      parseRobotsTxt("User-agent: *\nCrawl-delay: 60\n").groups[0]
        ?.crawlDelayMs,
    ).toBe(10_000);
    expect(
      parseRobotsTxt("User-agent: *\nCrawl-delay: soon\n").groups[0]
        ?.crawlDelayMs,
    ).toBeNull();
  });

  it("reads only the first 512 KB", () => {
    const filler = `# ${"x".repeat(600_000)}\n`;
    const robots = parseRobotsTxt(`User-agent: *\n${filler}Disallow: /late\n`);
    expect(robots.groups[0]?.rules).toEqual([]);
  });
});

describe("robotsVerdictForStatus", () => {
  it.each([
    [200, "OK"],
    [204, "OK"],
    [404, "MISSING"],
    [410, "MISSING"],
    [403, "MISSING"],
    [429, "SERVER_ERROR"],
    [500, "SERVER_ERROR"],
    [503, "SERVER_ERROR"],
    [null, "UNREACHABLE"],
  ] as const)("%s → %s", (status, verdict) => {
    expect(robotsVerdictForStatus(status)).toBe(verdict);
  });
});

describe("aiCrawlerAccess", () => {
  it("reports each AI crawler for '/'", () => {
    const robots = parseRobotsTxt(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n",
    );
    const access = aiCrawlerAccess(robots);
    expect(access).toHaveLength(AI_CRAWLERS.length);
    expect(access.find((row) => row.token === "GPTBot")).toEqual({
      token: "GPTBot",
      owner: "OpenAI",
      purpose: "training",
      allowed: false,
    });
    expect(access.find((row) => row.token === "CCBot")?.allowed).toBe(false);
    expect(access.find((row) => row.token === "OAI-SearchBot")?.allowed).toBe(
      true,
    );
    expect(aiCrawlerAccess(null).every((row) => row.allowed)).toBe(true);
  });
});

describe("hash and diff", () => {
  it("hash ignores line endings and trailing whitespace", () => {
    expect(robotsTextHash("User-agent: *\r\nDisallow: /a  \r\n")).toBe(
      robotsTextHash("User-agent: *\nDisallow: /a\n"),
    );
    expect(robotsTextHash("User-agent: *\nDisallow: /a")).not.toBe(
      robotsTextHash("User-agent: *\nDisallow: /b"),
    );
    expect(robotsTextHash("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("diff compares normalised lines as multisets", () => {
    const before = "User-agent: *\nDisallow: /a\nDisallow: /a\n# c\n";
    const after = "user-agent: *\nDisallow: /b\nDisallow: /a\n";
    expect(robotsDiff(before, after)).toEqual({
      added: ["disallow: /b"],
      removed: ["disallow: /a"],
    });
    expect(
      robotsDiff("Disallow: /x\nAllow: /y", "Allow: /y\nDisallow: /x"),
    ).toEqual({ added: [], removed: [] });
  });

  it("caps each side at 50 lines", () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) => `Disallow: /p${index}`,
    ).join("\n");
    expect(robotsDiff("", lines).added).toHaveLength(50);
  });
});

describe("pathological input", () => {
  it("finishes in bounded time", () => {
    const pattern = "/*a*a*a*a*a*b";
    const path = `/${"a".repeat(2_000)}`;
    const started = performance.now();
    expect(robotsPatternMatches(pattern, path)).toBe(false);
    const rules = Array.from(
      { length: 2_000 },
      () => `Disallow: ${pattern}`,
    ).join("\n");
    const robots = parseRobotsTxt(`User-agent: *\n${rules}\n`);
    expect(isAllowed(robots, "Googlebot", path).allowed).toBe(true);
    expect(isAllowed(robots, "Googlebot", `${path}b`).allowed).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("a huge pattern against a short path stops early", () => {
    const pattern = `/${"*a".repeat(100_000)}`;
    const started = performance.now();
    expect(robotsPatternMatches(pattern, "/aaa")).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
