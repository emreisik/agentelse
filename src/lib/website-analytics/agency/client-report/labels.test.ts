import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLIENT_REPORT_LABEL_KEYS,
  fillLabel,
  lab,
  resolveClientReportLabels,
} from "./labels";

// Bu dosyanın kanıtladığı: bilinmeyen/boş dil İngilizceye düşer; dönüştürücü ve
// görünümün kullandığı her etiket anahtarı tabloda vardır ve doludur; yer
// tutucu doldurma.

const ROOT = process.cwd();

function usedKeys(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const keys = new Set<string>();
  // Anahtarlar ad alanıyla başlar ("section.", "table.", ...); dizge olarak
  // geçtikleri her yer sayılır (lab() çağrısı ya da parametre).
  const namespaces =
    "section|table|kpi|finding|goal|forecast|measurement|outcomes|insights|plan|footnote|meta|md|view";
  for (const match of source.matchAll(
    new RegExp(`"((?:${namespaces})\\.[A-Za-z0-9]+)"`, "g"),
  )) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys];
}

describe("resolveClientReportLabels", () => {
  it("falls back to English for unknown, empty and missing languages", () => {
    const en = resolveClientReportLabels("en");
    expect(resolveClientReportLabels("xx")).toBe(en);
    expect(resolveClientReportLabels("")).toBe(en);
    expect(resolveClientReportLabels(null)).toBe(en);
    expect(resolveClientReportLabels(undefined)).toBe(en);
    expect(resolveClientReportLabels("en-GB")).toBe(en);
  });

  it("fills every key with a non-empty string", () => {
    const en = resolveClientReportLabels("en");
    for (const key of CLIENT_REPORT_LABEL_KEYS) {
      expect(typeof en[key]).toBe("string");
      expect(en[key]?.trim()).not.toBe("");
    }
  });
});

describe("label keys in use", () => {
  it.each([
    "src/lib/website-analytics/agency/client-report/convert.ts",
    "src/lib/website-analytics/agency/client-report/markdown.ts",
    "src/components/website-analytics/agency/client-report-view.tsx",
  ])("every key %s uses exists", (file) => {
    const known = new Set<string>(CLIENT_REPORT_LABEL_KEYS);
    const used = usedKeys(file);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(known.has(key), key).toBe(true);
  });
});

describe("lab and fillLabel", () => {
  it("reads a key and falls back to English when a table lacks it", () => {
    expect(lab({}, "section.keyNumbers")).toBe("Key numbers");
    expect(lab({ "section.keyNumbers": "Zahlen" }, "section.keyNumbers")).toBe(
      "Zahlen",
    );
  });

  it("fills placeholders and keeps unknown ones", () => {
    expect(fillLabel("{a} and {b} and {c}", { a: 1, b: "x" })).toBe(
      "1 and x and {c}",
    );
  });
});
