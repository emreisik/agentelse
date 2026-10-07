import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HEALTH_FIX_KINDS,
  INSPECTION_ALERT_KINDS,
  OPEN_ACTION_STATUSES,
  SEO_ACTION_STATUSES,
  SEO_FIX_KINDS,
  TERMINAL_ACTION_STATUSES,
  fixKindForFinding,
  isFixableFindingKind,
  isSeoActionStatus,
  isSeoFixKind,
} from "./kinds";

// Bu dosyanın kanıtladığı: bulgu türü eşlemesi, sağlık uyarısı listesi tam
// olarak kararlaştırılan türleri kapsar ve modül istemci için güvenlidir.

describe("fixKindForFinding", () => {
  it("keeps the name of fixable kinds and drops the rest", () => {
    expect(fixKindForFinding("TITLE_META")).toBe("TITLE_META");
    expect(fixKindForFinding("CONTENT_REFRESH")).toBe("CONTENT_REFRESH");
    expect(fixKindForFinding("NEW_CONTENT")).toBe("NEW_CONTENT");
    expect(fixKindForFinding("LOCALIZE")).toBe("LOCALIZE");
    expect(fixKindForFinding("INTERNAL_LINKS")).toBe("INTERNAL_LINKS");
    expect(fixKindForFinding("CONSOLIDATE")).toBe("CONSOLIDATE");
    expect(fixKindForFinding("TECH_FIX")).toBe("TECH_FIX");
    expect(fixKindForFinding("SCHEMA")).toBe("SCHEMA");
    expect(fixKindForFinding("INVESTIGATE")).toBeNull();
    expect(fixKindForFinding("SOMETHING_ELSE")).toBeNull();
    expect(fixKindForFinding("")).toBeNull();
  });

  it("isFixableFindingKind mirrors it", () => {
    expect(isFixableFindingKind("TITLE_META")).toBe(true);
    expect(isFixableFindingKind("INVESTIGATE")).toBe(false);
  });
});

describe("kind and status guards", () => {
  it("accepts every declared value and nothing else", () => {
    for (const kind of SEO_FIX_KINDS) expect(isSeoFixKind(kind)).toBe(true);
    for (const status of SEO_ACTION_STATUSES) {
      expect(isSeoActionStatus(status)).toBe(true);
    }
    expect(isSeoFixKind("INVESTIGATE")).toBe(false);
    expect(isSeoFixKind(3)).toBe(false);
    expect(isSeoActionStatus("DONE")).toBe(false);
    expect(isSeoActionStatus(null)).toBe(false);
  });

  it("splits statuses into open and terminal without overlap", () => {
    const all = [...OPEN_ACTION_STATUSES, ...TERMINAL_ACTION_STATUSES];
    expect(new Set(all).size).toBe(SEO_ACTION_STATUSES.length);
    expect([...all].sort()).toEqual([...SEO_ACTION_STATUSES].sort());
    expect(OPEN_ACTION_STATUSES).toEqual([
      "PROPOSED",
      "ACCEPTED",
      "APPLIED",
      "VERIFIED",
      "EVALUATING",
    ]);
  });
});

describe("HEALTH_FIX_KINDS", () => {
  it("covers exactly the decided alert kinds", () => {
    expect(Object.keys(HEALTH_FIX_KINDS).sort()).toEqual(
      [
        "GSC_CANONICAL_MISMATCH",
        "GSC_RICH_RESULTS",
        "GSC_SITEMAP_ERRORS",
        "SEO_CANONICAL_OFFSITE",
        "SEO_CWV_POOR",
        "SEO_HREFLANG",
        "SEO_KEY_PAGE_ERROR",
        "SEO_KEY_PAGE_NOINDEX",
        "SEO_REDIRECT_CHAINS",
        "SEO_ROBOTS_BLOCK",
        "SEO_SITEMAP_HYGIENE",
        "SEO_SITEMAP_MISSING",
        "SEO_STRUCTURED_DATA",
      ].sort(),
    );
  });

  it("maps each kind to its action kind and tech issue", () => {
    expect(HEALTH_FIX_KINDS.SEO_KEY_PAGE_NOINDEX).toEqual({
      kind: "TECH_FIX",
      issue: "NOINDEX",
    });
    expect(HEALTH_FIX_KINDS.SEO_KEY_PAGE_ERROR?.issue).toBe("STATUS");
    expect(HEALTH_FIX_KINDS.SEO_ROBOTS_BLOCK?.issue).toBe("ROBOTS");
    expect(HEALTH_FIX_KINDS.SEO_CANONICAL_OFFSITE?.issue).toBe("CANONICAL");
    expect(HEALTH_FIX_KINDS.GSC_CANONICAL_MISMATCH?.issue).toBe("CANONICAL");
    expect(HEALTH_FIX_KINDS.SEO_REDIRECT_CHAINS?.issue).toBe("REDIRECT");
    expect(HEALTH_FIX_KINDS.SEO_HREFLANG?.issue).toBe("HREFLANG");
    expect(HEALTH_FIX_KINDS.SEO_STRUCTURED_DATA?.kind).toBe("SCHEMA");
    expect(HEALTH_FIX_KINDS.GSC_RICH_RESULTS?.kind).toBe("SCHEMA");
    expect(HEALTH_FIX_KINDS.SEO_CWV_POOR?.kind).toBe("CWV_FIX");
    expect(HEALTH_FIX_KINDS.GSC_SITEMAP_ERRORS?.kind).toBe("SITEMAP_FIX");
    expect(HEALTH_FIX_KINDS.SEO_SITEMAP_MISSING?.kind).toBe("SITEMAP_FIX");
    expect(HEALTH_FIX_KINDS.SEO_SITEMAP_HYGIENE?.kind).toBe("SITEMAP_FIX");
  });

  it("inspection alert kinds are all health fix kinds", () => {
    expect([...INSPECTION_ALERT_KINDS]).toEqual([
      "GSC_CANONICAL_MISMATCH",
      "GSC_RICH_RESULTS",
    ]);
    for (const kind of INSPECTION_ALERT_KINDS) {
      expect(HEALTH_FIX_KINDS[kind]).toBeDefined();
    }
  });
});

describe("client safety", () => {
  it("has no runtime import of crawl-url, normalize or node builtins", () => {
    for (const name of ["kinds.ts", "copy.ts"]) {
      const text = readFileSync(join(__dirname, name), "utf8");
      const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      for (const spec of specs) {
        expect(spec).not.toMatch(/crawl-url|normalize|node:|dates/);
      }
      expect(text).not.toMatch(/from\s+["']node:/);
    }
  });
});
