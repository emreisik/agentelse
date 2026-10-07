import { describe, expect, it } from "vitest";

import { parseRobotsTxt } from "@/lib/seo/robots-parser";

import { GEO_CHECKS } from "./catalog";
import { evaluateGeo, rescore, type GeoInput } from "./evaluate";
import { GEO_CHECK_IDS, type GeoCheckId, type OrgFacts } from "./types";

// Bu dosyanın kanıtladığı (SC-F8): GEO1-GEO11'in her PASS/WARN/INFO/NA/ACK
// sınırı, puan hesabı (NA/ACK dışarıda, GEO3 puansız), rescore'un yeni
// değerlendirmeyle aynı sonucu vermesi ve çıktının belirleyiciliği.

const NOW = new Date("2026-10-07T10:00:00.000Z");

const ORG: OrgFacts = {
  present: true,
  types: ["Organization"],
  name: "Acme",
  sameAs: ["https://twitter.com/acme", "https://linkedin.com/company/acme"],
  hasLogo: true,
};

function page(
  path: string,
  overrides: Partial<GeoInput["pages"][number]> = {},
): GeoInput["pages"][number] {
  return {
    path,
    wordCount: 400,
    schemaTypes: [],
    h2: ["Intro"],
    robotsMeta: null,
    xRobotsTag: null,
    indexable: true,
    status: 200,
    ...overrides,
  };
}

function pages(count: number, overrides: Partial<GeoInput["pages"][number]> = {}) {
  return Array.from({ length: count }, (_, index) => page(`/p${index}`, overrides));
}

function input(overrides: Partial<GeoInput> = {}): GeoInput {
  return {
    robots: null,
    robotsVerdict: "MISSING",
    llms: { state: "missing", text: null },
    home: {
      status: 200,
      schemaTypes: ["Organization"],
      renderRisk: false,
      title: "Acme | Widgets",
      org: ORG,
    },
    pages: [],
    brandName: "Acme",
    connectedHandles: [],
    acknowledged: [],
    now: NOW,
    ...overrides,
  };
}

const statusOf = (result: ReturnType<typeof evaluateGeo>, id: GeoCheckId) =>
  result.checks.find((check) => check.id === id)?.status;

describe("GEO1 llms.txt", () => {
  const valid = "# Acme\n\n- [A](https://acme.test/a)\n";
  it("passes a valid file", () => {
    const result = evaluateGeo(input({ llms: { state: "present", text: valid } }));
    expect(statusOf(result, "GEO1")).toBe("PASS");
    expect(result.llms).toMatchObject({ state: "present", hasTitle: true, links: 1 });
  });

  it.each([
    ["empty", ""],
    ["no title", "Just text"],
    ["html", "<html><body>x</body></html>"],
  ])("warns about an invalid file (%s)", (_label, text) => {
    const result = evaluateGeo(input({ llms: { state: "present", text } }));
    expect(statusOf(result, "GEO1")).toBe("WARN");
    expect(result.llms.state).toBe("invalid");
  });

  it("informs when missing and is not applicable when blocked or unknown", () => {
    expect(statusOf(evaluateGeo(input()), "GEO1")).toBe("INFO");
    for (const state of ["blocked", "unknown"] as const) {
      expect(
        statusOf(evaluateGeo(input({ llms: { state, text: null } })), "GEO1"),
      ).toBe("NA");
    }
    expect(
      statusOf(evaluateGeo(input({ llms: { state: "present", text: null } })), "GEO1"),
    ).toBe("NA");
  });
});

describe("GEO2 and GEO3 AI crawlers", () => {
  const blockAll = parseRobotsTxt("User-agent: *\nDisallow: /\n");
  const blockOne = parseRobotsTxt("User-agent: GPTBot\nDisallow: /\n");
  const blockSearch = parseRobotsTxt("User-agent: PerplexityBot\nDisallow: /\n");

  it("is not applicable when robots.txt could not be read", () => {
    const result = evaluateGeo(input({ robots: null, robotsVerdict: "UNREACHABLE" }));
    expect(statusOf(result, "GEO2")).toBe("NA");
    expect(statusOf(result, "GEO3")).toBe("NA");
    expect(result.crawlers).toEqual([]);
    const missingVerdict = evaluateGeo(input({ robots: null, robotsVerdict: null }));
    expect(statusOf(missingVerdict, "GEO2")).toBe("NA");
  });

  it("passes when everything is allowed, also without a robots.txt", () => {
    expect(statusOf(evaluateGeo(input()), "GEO2")).toBe("PASS");
    expect(
      statusOf(evaluateGeo(input({ robots: blockOne, robotsVerdict: "OK" })), "GEO2"),
    ).toBe("PASS");
  });

  it("warns and lists the blocked search crawlers", () => {
    const result = evaluateGeo(input({ robots: blockSearch, robotsVerdict: "OK" }));
    const check = result.checks.find((entry) => entry.id === "GEO2");
    expect(check?.status).toBe("WARN");
    expect(check?.facts).toMatchObject({ blocked: ["PerplexityBot"], blockedCount: 1, allowed: 4 });
    expect(statusOf(evaluateGeo(input({ robots: blockAll, robotsVerdict: "OK" })), "GEO2")).toBe("WARN");
  });

  it("only informs about training crawlers", () => {
    const result = evaluateGeo(input({ robots: blockOne, robotsVerdict: "OK" }));
    const check = result.checks.find((entry) => entry.id === "GEO3");
    expect(check?.status).toBe("INFO");
    expect(check?.facts).toMatchObject({ blockedCount: 1, allowed: 5, blocked: ["GPTBot"] });
    expect(GEO_CHECKS.GEO3.scored).toBe(false);
  });

  it("shows ACK when acknowledged and the check was WARN", () => {
    const result = evaluateGeo(
      input({ robots: blockSearch, robotsVerdict: "OK", acknowledged: ["GEO2"] }),
    );
    expect(statusOf(result, "GEO2")).toBe("ACK");
  });

  it("keeps PASS when acknowledged but nothing is blocked", () => {
    expect(statusOf(evaluateGeo(input({ acknowledged: ["GEO2"] })), "GEO2")).toBe("PASS");
  });

  it("never acknowledges a check that cannot be acknowledged", () => {
    const result = evaluateGeo(
      input({ llms: { state: "present", text: "no title" }, acknowledged: ["GEO1"] }),
    );
    expect(statusOf(result, "GEO1")).toBe("WARN");
  });
});

describe("GEO4 homepage HTML", () => {
  it("is not applicable without usable homepage data", () => {
    expect(statusOf(evaluateGeo(input({ home: null })), "GEO4")).toBe("NA");
    const notFound = input();
    notFound.home = { ...notFound.home!, status: 404 };
    expect(statusOf(evaluateGeo(notFound), "GEO4")).toBe("NA");
    const noStatus = input();
    noStatus.home = { ...noStatus.home!, status: null };
    expect(statusOf(evaluateGeo(noStatus), "GEO4")).toBe("NA");
  });

  it("warns on render risk and passes otherwise", () => {
    const risky = input();
    risky.home = { ...risky.home!, renderRisk: true };
    expect(statusOf(evaluateGeo(risky), "GEO4")).toBe("WARN");
    expect(statusOf(evaluateGeo(input()), "GEO4")).toBe("PASS");
  });
});

describe("GEO5 and GEO6 organization", () => {
  it("is not applicable without homepage data and warns without Organization", () => {
    expect(statusOf(evaluateGeo(input({ home: null })), "GEO5")).toBe("NA");
    const none = input();
    none.home = { ...none.home!, org: null };
    expect(statusOf(evaluateGeo(none), "GEO5")).toBe("WARN");
    const absent = input();
    absent.home = { ...absent.home!, org: { ...ORG, present: false } };
    expect(statusOf(evaluateGeo(absent), "GEO5")).toBe("WARN");
    expect(statusOf(evaluateGeo(input()), "GEO5")).toBe("PASS");
  });

  it("GEO6 is not applicable when GEO5 is absent", () => {
    const none = input();
    none.home = { ...none.home!, org: null };
    expect(statusOf(evaluateGeo(none), "GEO6")).toBe("NA");
    expect(statusOf(evaluateGeo(input({ home: null })), "GEO6")).toBe("NA");
  });

  it("GEO6 warns below two distinct hosts and passes at two", () => {
    const zero = input();
    zero.home = { ...zero.home!, org: { ...ORG, sameAs: [] } };
    expect(statusOf(evaluateGeo(zero), "GEO6")).toBe("WARN");
    const oneHost = input();
    oneHost.home = {
      ...oneHost.home!,
      org: { ...ORG, sameAs: ["https://twitter.com/a", "https://www.twitter.com/b"] },
    };
    expect(statusOf(evaluateGeo(oneHost), "GEO6")).toBe("WARN");
    expect(statusOf(evaluateGeo(input()), "GEO6")).toBe("PASS");
  });

  it("GEO6 informs when connected handles do not appear in sameAs", () => {
    expect(
      statusOf(evaluateGeo(input({ connectedHandles: ["otherbrand"] })), "GEO6"),
    ).toBe("INFO");
    expect(
      statusOf(evaluateGeo(input({ connectedHandles: ["@Acme"] })), "GEO6"),
    ).toBe("PASS");
    expect(
      statusOf(evaluateGeo(input({ connectedHandles: ["x"] })), "GEO6"),
    ).toBe("PASS");
  });
});

describe("GEO7 FAQ and how-to markup", () => {
  it("is not applicable below five indexable pages", () => {
    expect(statusOf(evaluateGeo(input({ pages: pages(4) })), "GEO7")).toBe("NA");
    expect(
      statusOf(evaluateGeo(input({ pages: pages(4).concat(page("/x", { indexable: false })) })), "GEO7"),
    ).toBe("NA");
  });

  it("passes with one FAQPage or HowTo and informs otherwise", () => {
    const withFaq = pages(5);
    withFaq[2] = page("/faq", { schemaTypes: ["faqpage"] });
    expect(statusOf(evaluateGeo(input({ pages: withFaq })), "GEO7")).toBe("PASS");
    const withHowTo = pages(5);
    withHowTo[0] = page("/how", { schemaTypes: ["HowTo"] });
    expect(statusOf(evaluateGeo(input({ pages: withHowTo })), "GEO7")).toBe("PASS");
    expect(statusOf(evaluateGeo(input({ pages: pages(5) })), "GEO7")).toBe("INFO");
  });
});

describe("GEO8 question headings", () => {
  it("is not applicable below five content pages", () => {
    const short = pages(10, { wordCount: 299 });
    expect(statusOf(evaluateGeo(input({ pages: short })), "GEO8")).toBe("NA");
    expect(statusOf(evaluateGeo(input({ pages: pages(4) })), "GEO8")).toBe("NA");
  });

  it("passes at 20 percent and warns below", () => {
    const list = pages(5);
    list[0] = page("/q", { h2: ["How does it work?"] });
    expect(statusOf(evaluateGeo(input({ pages: list })), "GEO8")).toBe("PASS");
    const ten = pages(10);
    ten[0] = page("/q", { h2: ["Why us"] });
    const result = evaluateGeo(input({ pages: ten }));
    expect(statusOf(result, "GEO8")).toBe("WARN");
    expect(result.pages.withQuestionHeadings).toBe(1);
    const exactly = pages(10);
    exactly[0] = page("/a", { h2: ["What is it"] });
    exactly[1] = page("/b", { h2: ["Is it safe"] });
    expect(statusOf(evaluateGeo(input({ pages: exactly })), "GEO8")).toBe("PASS");
  });
});

describe("GEO9 snippet controls", () => {
  it("is not applicable without indexable pages", () => {
    expect(statusOf(evaluateGeo(input({ pages: [] })), "GEO9")).toBe("NA");
    expect(
      statusOf(evaluateGeo(input({ pages: [page("/x", { indexable: false, robotsMeta: "nosnippet" })] })), "GEO9"),
    ).toBe("NA");
  });

  it("passes when nothing blocks snippets", () => {
    const list = [page("/a", { robotsMeta: "index, follow, max-snippet:-1" }), page("/b", { xRobotsTag: "max-snippet:50" })];
    expect(statusOf(evaluateGeo(input({ pages: list })), "GEO9")).toBe("PASS");
  });

  it.each([
    ["robotsMeta", { robotsMeta: "noindex, nosnippet" }],
    ["robotsMeta", { robotsMeta: "max-snippet:0" }],
    ["xRobotsTag", { xRobotsTag: "googlebot: nosnippet" }],
    ["xRobotsTag", { xRobotsTag: "max-snippet: 0" }],
  ] as const)("warns on %s %j", (_field, override) => {
    const result = evaluateGeo(input({ pages: [page("/a", override), page("/b")] }));
    expect(statusOf(result, "GEO9")).toBe("WARN");
    expect(result.pages.snippetBlocked).toBe(1);
  });

  it("can be acknowledged", () => {
    const list = [page("/a", { robotsMeta: "nosnippet" })];
    expect(
      statusOf(evaluateGeo(input({ pages: list, acknowledged: ["GEO9"] })), "GEO9"),
    ).toBe("ACK");
  });
});

describe("GEO10 page structure", () => {
  it("is not applicable without long pages", () => {
    expect(statusOf(evaluateGeo(input({ pages: pages(5, { wordCount: 599 }) })), "GEO10")).toBe("NA");
  });

  it("passes below 20 percent without H2 and warns from 20 percent", () => {
    const six = pages(6, { wordCount: 700 });
    six[0] = page("/a", { wordCount: 700, h2: [] });
    expect(statusOf(evaluateGeo(input({ pages: six })), "GEO10")).toBe("PASS");
    const five = pages(5, { wordCount: 700 });
    five[0] = page("/a", { wordCount: 700, h2: [] });
    const result = evaluateGeo(input({ pages: five }));
    expect(statusOf(result, "GEO10")).toBe("WARN");
    expect(result.pages.longWithoutHeadings).toBe(1);
  });
});

describe("GEO11 entity consistency", () => {
  it("is not applicable when a name is missing", () => {
    expect(statusOf(evaluateGeo(input({ brandName: null })), "GEO11")).toBe("NA");
    const noTitle = input();
    noTitle.home = { ...noTitle.home!, title: null };
    expect(statusOf(evaluateGeo(noTitle), "GEO11")).toBe("NA");
    const noName = input();
    noName.home = { ...noName.home!, org: { ...ORG, name: null } };
    expect(statusOf(evaluateGeo(noName), "GEO11")).toBe("NA");
  });

  it("passes when everything agrees and informs otherwise", () => {
    expect(statusOf(evaluateGeo(input()), "GEO11")).toBe("PASS");
    expect(statusOf(evaluateGeo(input({ brandName: "Globex" })), "GEO11")).toBe("INFO");
    const titleOff = input();
    titleOff.home = { ...titleOff.home!, title: "Best widgets in town" };
    expect(statusOf(evaluateGeo(titleOff), "GEO11")).toBe("INFO");
  });
});

describe("score", () => {
  it("is 100 when every applicable scored check passes", () => {
    const result = evaluateGeo(
      input({ llms: { state: "present", text: "# Acme\n" }, pages: [] }),
    );
    expect(result.score).toBe(100);
  });

  it("counts INFO as half and WARN as zero over the applicable weights", () => {
    // GEO1 INFO(5) + GEO2 PASS(20) + GEO4 PASS(10) + GEO5 PASS(12) + GEO6 PASS(10) + GEO11 PASS(5)
    const result = evaluateGeo(input());
    expect(result.score).toBe(Math.round((100 * (2.5 + 20 + 10 + 12 + 10 + 5)) / 62));
    // Başka bir kombinasyon: GEO4 WARN düşürür.
    const risky = input();
    risky.home = { ...risky.home!, renderRisk: true };
    expect(evaluateGeo(risky).score).toBe(
      Math.round((100 * (2.5 + 20 + 0 + 12 + 10 + 5)) / 62),
    );
  });

  it("excludes NA and ACK and ignores GEO3", () => {
    const robots = parseRobotsTxt("User-agent: PerplexityBot\nDisallow: /\n");
    const open = evaluateGeo(input({ robots, robotsVerdict: "OK" }));
    const acked = evaluateGeo(input({ robots, robotsVerdict: "OK", acknowledged: ["GEO2"] }));
    expect(open.score).toBeLessThan(acked.score ?? 0);
    // ACK: ağırlık 20 paydadan da düşer
    expect(acked.score).toBe(Math.round((100 * (2.5 + 10 + 12 + 10 + 5)) / 42));
    const blockedTraining = evaluateGeo(
      input({ robots: parseRobotsTxt("User-agent: GPTBot\nDisallow: /\n"), robotsVerdict: "OK" }),
    );
    expect(blockedTraining.score).toBe(evaluateGeo(input()).score);
  });

  it("is null when no scored check applies", () => {
    const result = evaluateGeo(
      input({
        robots: null,
        robotsVerdict: "UNREACHABLE",
        llms: { state: "unknown", text: null },
        home: null,
      }),
    );
    expect(result.score).toBeNull();
  });
});

describe("rescore", () => {
  const robots = parseRobotsTxt("User-agent: ChatGPT-User\nDisallow: /\n");
  const noindexSnippet = [page("/a", { robotsMeta: "nosnippet" })];
  const base = input({ robots, robotsVerdict: "OK", pages: noindexSnippet });

  it("equals a fresh evaluation with the same acknowledgements", () => {
    const fresh = evaluateGeo(base);
    for (const ack of [[], ["GEO2"], ["GEO9"], ["GEO2", "GEO9"]] as GeoCheckId[][]) {
      expect(rescore(fresh, ack)).toEqual(evaluateGeo({ ...base, acknowledged: ack }));
    }
  });

  it("can remove an acknowledgement again", () => {
    const acked = evaluateGeo({ ...base, acknowledged: ["GEO2", "GEO9"] });
    expect(rescore(acked, [])).toEqual(evaluateGeo(base));
  });

  it("ignores ids that cannot be acknowledged", () => {
    const fresh = evaluateGeo(base);
    expect(rescore(fresh, ["GEO1", "GEO4"] as GeoCheckId[])).toEqual(fresh);
  });
});

describe("determinism", () => {
  it("returns identical JSON and ordered checks for the same input", () => {
    const list = pages(6);
    const a = evaluateGeo(input({ pages: list }));
    const b = evaluateGeo(input({ pages: list }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.checks.map((check) => check.id)).toEqual([...GEO_CHECK_IDS]);
    expect(a.auditedAt).toBe(NOW.toISOString());
    expect(a.v).toBe(1);
  });

  it("summarises the audited pages", () => {
    const list = [page("/a"), page("/b", { indexable: false }), page("/c", { schemaTypes: ["FAQPage"] })];
    const result = evaluateGeo(input({ pages: list }));
    expect(result.pages).toMatchObject({ audited: 3, indexable: 2, withFaqSchema: 1, renderRisk: 0 });
    expect(result.org).toEqual(ORG);
  });
});
