import { describe, expect, it } from "vitest";

import {
  EMPTY_PAGE_GROUP_RULES,
  PAGE_GROUP_MAX_RULES,
  defaultGroupOf,
  groupFor,
  matchPattern,
  parsePageGroupRules,
  previewGroups,
  validatePageGroupRules,
  type PageGroupRules,
} from "./page-groups";

function rules(...items: [string, "PREFIX" | "GLOB" | "EXACT", string][]): PageGroupRules {
  return {
    v: 1,
    rules: items.map(([group, match, pattern], at) => ({
      id: `r${at}`,
      group,
      match,
      pattern,
    })),
  };
}

describe("matchPattern", () => {
  it("PREFIX respects segment boundaries", () => {
    expect(matchPattern("PREFIX", "/blog", "/blog")).toBe(true);
    expect(matchPattern("PREFIX", "/blog", "/blog/x")).toBe(true);
    expect(matchPattern("PREFIX", "/blog", "/blogger")).toBe(false);
    expect(matchPattern("PREFIX", "/blog/", "/blog/x/y")).toBe(true);
    expect(matchPattern("PREFIX", "/", "/anything")).toBe(true);
  });

  it("EXACT matches the whole path", () => {
    expect(matchPattern("EXACT", "/about", "/about")).toBe(true);
    expect(matchPattern("EXACT", "/about", "/about/team")).toBe(false);
    expect(matchPattern("EXACT", "/", "/")).toBe(true);
  });

  it("GLOB star stays inside one segment", () => {
    expect(matchPattern("GLOB", "/shop/*/reviews", "/shop/shoes/reviews")).toBe(true);
    expect(matchPattern("GLOB", "/shop/*/reviews", "/shop/a/b/reviews")).toBe(false);
    expect(matchPattern("GLOB", "/p/item-*", "/p/item-42")).toBe(true);
    expect(matchPattern("GLOB", "/p/item-*", "/p/other-42")).toBe(false);
    expect(matchPattern("GLOB", "/a/*", "/a")).toBe(false);
  });

  it("GLOB ** as the last segment matches zero or more segments", () => {
    expect(matchPattern("GLOB", "/docs/**", "/docs")).toBe(true);
    expect(matchPattern("GLOB", "/docs/**", "/docs/a/b/c")).toBe(true);
    expect(matchPattern("GLOB", "/docs/**", "/other/a")).toBe(false);
    expect(matchPattern("GLOB", "/*/guide/**", "/en/guide/x/y")).toBe(true);
    expect(matchPattern("GLOB", "/**", "/")).toBe(true);
  });

  it("is case-insensitive and ignores a trailing slash", () => {
    expect(matchPattern("EXACT", "/About", "/about/")).toBe(true);
    expect(matchPattern("PREFIX", "/BLOG", "/Blog/Post")).toBe(true);
  });

  it("runs a pathological glob in linear time", () => {
    const path = `/${"a".repeat(5000)}`;
    const started = performance.now();
    expect(matchPattern("GLOB", "/*a*a*a*a*a*b", path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("groupFor", () => {
  const set = rules(
    ["/shop/reviews", "GLOB", "/shop/*/reviews"],
    ["/shop", "PREFIX", "/shop"],
  );

  it("takes the first matching rule", () => {
    expect(groupFor(set, "/shop/x/reviews")).toBe("/shop/reviews");
    expect(groupFor(set, "/shop/x")).toBe("/shop");
  });

  it("falls back to the first path segment", () => {
    expect(groupFor(set, "/blog/post")).toBe("/blog");
    expect(groupFor(EMPTY_PAGE_GROUP_RULES, "/")).toBe("/");
    expect(defaultGroupOf("/Mixed/Case")).toBe("/Mixed");
  });
});

describe("validatePageGroupRules", () => {
  it("accepts valid rules, lowercases groups and generates ids", () => {
    const result = validatePageGroupRules([
      { group: " /Shop/Reviews ", match: "GLOB", pattern: "/shop/*/reviews" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules.rules[0]?.group).toBe("/shop/reviews");
    expect(result.rules.rules[0]?.id).toMatch(/^r_/);
  });

  it("rejects ** anywhere but as the last whole segment", () => {
    const result = validatePageGroupRules([
      { group: "/a", match: "GLOB", pattern: "/x/**/y" },
      { group: "/b", match: "GLOB", pattern: "/x/a**" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.index, e.field])).toEqual([
      [0, "pattern"],
      [1, "pattern"],
    ]);
  });

  it("forbids * in PREFIX and EXACT, and bad group names", () => {
    const result = validatePageGroupRules([
      { group: "/ok", match: "PREFIX", pattern: "/a*" },
      { group: "shop", match: "EXACT", pattern: "/a" },
      { group: "/a/b/c/d", match: "EXACT", pattern: "/a" },
      { group: "/ok", match: "EXACT", pattern: "no-slash" },
      { group: "/ok", match: "REGEX", pattern: "/a" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => `${e.index}:${e.field}`)).toEqual([
      "0:pattern",
      "1:group",
      "2:group",
      "3:pattern",
      "4:match",
    ]);
  });

  it("caps the list at 40 rules", () => {
    const many = Array.from({ length: PAGE_GROUP_MAX_RULES + 1 }, (_, at) => ({
      group: `/g${at}`,
      match: "PREFIX",
      pattern: `/p${at}`,
    }));
    expect(validatePageGroupRules(many).ok).toBe(false);
    expect(validatePageGroupRules(many.slice(0, PAGE_GROUP_MAX_RULES)).ok).toBe(true);
  });

  it("allows duplicate group names and rejects a non-list", () => {
    const dup = validatePageGroupRules([
      { group: "/a", match: "PREFIX", pattern: "/x" },
      { group: "/a", match: "PREFIX", pattern: "/y" },
    ]);
    expect(dup.ok).toBe(true);
    expect(validatePageGroupRules("nope").ok).toBe(false);
  });
});

describe("parsePageGroupRules", () => {
  it("drops bad rules, repairs duplicate ids and caps at 40", () => {
    const parsed = parsePageGroupRules({
      v: 1,
      rules: [
        { id: "x", group: "/a", match: "PREFIX", pattern: "/a" },
        { id: "x", group: "/b", match: "PREFIX", pattern: "/b" },
        { id: "y", group: "BAD", match: "PREFIX", pattern: "/c" },
        null,
      ],
    });
    expect(parsed.rules).toHaveLength(2);
    expect(new Set(parsed.rules.map((rule) => rule.id)).size).toBe(2);
    expect(parsePageGroupRules(null)).toEqual(EMPTY_PAGE_GROUP_RULES);
    const many = {
      rules: Array.from({ length: 60 }, (_, at) => ({
        group: `/g${at}`,
        match: "PREFIX",
        pattern: `/p${at}`,
      })),
    };
    expect(parsePageGroupRules(many).rules).toHaveLength(PAGE_GROUP_MAX_RULES);
  });
});

describe("previewGroups", () => {
  it("counts groups, changes, unmatched pages and keeps 3 samples", () => {
    const preview = previewGroups(rules(["/shop/reviews", "GLOB", "/shop/*/reviews"]), [
      { path: "/shop/a/reviews", currentGroup: "/shop" },
      { path: "/shop/b/reviews", currentGroup: "/shop" },
      { path: "/shop/c/reviews", currentGroup: "/shop/reviews" },
      { path: "/shop/d/reviews", currentGroup: null },
      { path: "/blog/x", currentGroup: "/blog" },
    ]);
    expect(preview.sampled).toBe(5);
    expect(preview.changed).toBe(3);
    expect(preview.unmatched).toBe(1);
    expect(preview.groups[0]).toEqual({
      group: "/shop/reviews",
      pages: 4,
      samples: ["/shop/a/reviews", "/shop/b/reviews", "/shop/c/reviews"],
    });
    expect(preview.groups[1]?.group).toBe("/blog");
  });
});
