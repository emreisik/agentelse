import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MeasurementSummary } from "@/lib/website-analytics/health/view-types";

import {
  MeasurementDot,
  MeasurementScoreChip,
  MeasurementScoreLine,
} from "./measurement-score";

// Bu dosyanın kanıtladığı (GA-F3 puan gösterimleri): nokta tonları sabit
// sınıflara bağlı; satır puanı, düzeltme sayısını ve isteğe bağlı "View
// checks" bağlantısını gösterir; dosya istemci güvenli kalır (yalnız
// next/link, cn ve tür içe aktarımları).

const summary = (
  patch: Partial<MeasurementSummary> = {},
): MeasurementSummary => ({
  score: 72,
  tone: "warning",
  label: "72/100",
  issues: 2,
  critical: 0,
  evaluatedAt: "2026-10-06T10:00:00.000Z",
  ...patch,
});

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("MeasurementDot", () => {
  it.each([
    ["ok", "bg-emerald-500"],
    ["warning", "bg-amber-500"],
    ["error", "bg-rose-500"],
    ["unknown", "bg-muted-foreground"],
  ] as const)("uses the %s colour", (tone, klass) => {
    const html = renderToStaticMarkup(createElement(MeasurementDot, { tone }));
    expect(html).toContain(klass);
    expect(html).toContain("size-1.5");
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("MeasurementScoreLine", () => {
  it("shows the score, the issues and the link", () => {
    const html = renderToStaticMarkup(
      createElement(MeasurementScoreLine, {
        summary: summary(),
        href: "/projects/p1/site#measurement-health",
      }),
    );
    expect(text(html)).toContain("Measurement health 72/100 · 2 to fix");
    expect(html).toContain('href="/projects/p1/site#measurement-health"');
    expect(text(html)).toContain("View checks");
    expect(html).toContain("text-[11px]");
  });

  it("says no problems and has no link without an href", () => {
    const html = renderToStaticMarkup(
      createElement(MeasurementScoreLine, {
        summary: summary({ score: 96, tone: "ok", label: "96/100", issues: 0 }),
        href: null,
      }),
    );
    expect(text(html)).toContain(
      "Measurement health 96/100 · No problems found",
    );
    expect(html).not.toContain("<a");
    expect(html).not.toContain("View checks");
  });
});

describe("MeasurementScoreChip", () => {
  it("is a link pill with the score", () => {
    const html = renderToStaticMarkup(
      createElement(MeasurementScoreChip, {
        summary: summary({ tone: "error", score: 40, label: "40/100" }),
        href: "#measurement-health",
      }),
    );
    expect(html).toContain('href="#measurement-health"');
    expect(text(html)).toBe("Tracking 40/100");
    expect(html).toContain("bg-rose-500");
  });
});

describe("measurement-score.tsx imports", () => {
  it("imports only next/link, cn and type-only modules", () => {
    const source = readFileSync(
      path.join(__dirname, "measurement-score.tsx"),
      "utf8",
    );
    const imports = [
      ...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm),
    ];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, clause, from] of imports) {
      if (from === "next/link" || from === "@/lib/utils") continue;
      expect(clause?.startsWith("type "), `${from} must be a type import`).toBe(
        true,
      );
    }
    expect(source).not.toMatch(/^import\s+["']/m);
    expect(source).not.toContain("require(");
  });
});
