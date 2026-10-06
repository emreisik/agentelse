import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PACE_LABEL } from "@/lib/seo/reports/goals";
import type { GoalPace } from "@/lib/seo/reports/types";

import { SeoGoalPaceBadge, goalValueText } from "./seo-goal-pace-badge";

// Bu dosyanın kanıtladığı: her tempo kendi etiketiyle ve renk tonuyla çizilir
// (ulaşıldı yeşil, yolunda yeşil çerçeve, geride amber, risk kırmızı, bilinmiyor
// sönük); sayılar birimine göre biçimlenir.

function render(pace: GoalPace): string {
  return renderToStaticMarkup(
    createElement(SeoGoalPaceBadge, { pace, label: PACE_LABEL[pace] }),
  );
}

describe("SeoGoalPaceBadge", () => {
  it("her tempoyu etiketiyle çizer", () => {
    expect(render("achieved")).toContain("Reached");
    expect(render("on_track")).toContain("On track");
    expect(render("behind")).toContain("Behind");
    expect(render("at_risk")).toContain("At risk");
    expect(render("unknown")).toContain("Not enough data");
  });

  it("tonu tempoya göre seçer", () => {
    expect(render("achieved")).toContain("bg-emerald-500/15");
    expect(render("on_track")).toContain("ring-emerald-500/40");
    expect(render("on_track")).not.toContain("bg-emerald-500/15");
    expect(render("behind")).toContain("text-red-700");
    expect(render("at_risk")).toContain("text-amber-700");
    expect(render("unknown")).toContain("text-muted-foreground");
    expect(render("at_risk")).toContain('data-pace="at_risk"');
  });
});

describe("goalValueText", () => {
  it("sayı ve yüzde birimlerini ayırır", () => {
    expect(goalValueText("gsc.nonBrandClicks", 1200)).toBe("1,200");
    expect(goalValueText("seo.indexedShare", 91)).toBe("91%");
    expect(goalValueText("seo.cwvGoodShare", null)).toBe("—");
  });
});
