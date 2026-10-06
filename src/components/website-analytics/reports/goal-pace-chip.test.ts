import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { paceLabel } from "@/lib/website-analytics/reports/pace";
import type {
  GoalPace,
  GoalPaceChipView,
} from "@/lib/website-analytics/reports/types";

import { GoalPaceChip, paceDetailText } from "./goal-pace-chip";

// Bu dosyanın kanıtladığı: hedef hızı hapı her durumun etiketini ve ton rengini
// basar; ayrıntılı satır parayı para birimiyle biçimler, tahmin yoksa tahmin
// kısmını düşürür ve "Data through" günü yazar.

function view(partial: Partial<GoalPaceChipView> = {}): GoalPaceChipView {
  return {
    goalId: "goal-1",
    metricKey: "web.sessions",
    pace: "on_track",
    label: paceLabel("on_track"),
    tone: "good",
    month: "2026-10",
    monthLabel: "October 2026",
    through: "2026-10-04",
    monthToDate: 4120,
    target: 9000,
    forecast: 8400,
    low: 7900,
    high: 8900,
    basis: "ok",
    format: "count",
    currency: null,
    ...partial,
  };
}

const render = (props: { view: GoalPaceChipView; detailed?: boolean }) =>
  renderToStaticMarkup(createElement(GoalPaceChip, props));

describe("GoalPaceChip", () => {
  it.each<[GoalPace, string, GoalPaceChipView["tone"]]>([
    ["achieved", "Achieved", "good"],
    ["on_track", "On track", "good"],
    ["at_risk", "At risk", "warn"],
    ["behind", "Behind", "bad"],
    ["early", "Too early to tell", "neutral"],
    ["unknown", "No forecast yet", "neutral"],
  ])("prints the label for %s", (pace, label, tone) => {
    const html = render({ view: view({ pace, label, tone }) });
    expect(html).toContain(label);
    expect(html).toContain(`data-pace="${pace}"`);
  });

  it("colours the pill by tone", () => {
    expect(render({ view: view({ tone: "good" }) })).toContain("emerald");
    expect(render({ view: view({ tone: "warn" }) })).toContain("amber");
    expect(render({ view: view({ tone: "bad" }) })).toContain("red");
    expect(render({ view: view({ tone: "neutral" }) })).toContain(
      "text-muted-foreground",
    );
  });

  it("prints only the pill when not detailed", () => {
    const html = render({ view: view() });
    expect(html).not.toContain("so far");
    expect(html).not.toContain("Data through");
  });

  it("prints the detailed line with counts and the data day", () => {
    const html = render({ view: view(), detailed: true });
    expect(html).toContain(
      "October 2026 so far: 4,120 of 9,000 · forecast 8,400 (7,900–8,900)",
    );
    expect(html).toContain("Data through Oct 4");
  });

  it("formats money with the currency", () => {
    const text = paceDetailText(
      view({
        format: "money",
        currency: "EUR",
        metricKey: "web.revenue",
        monthToDate: 1200.5,
        target: 5000,
        forecast: 4800,
        low: 4500,
        high: 5100,
      }),
    );
    expect(text).toBe(
      "October 2026 so far: 1,200.50 EUR of 5,000 EUR · forecast 4,800 EUR (4,500 EUR–5,100 EUR)",
    );
  });

  it("drops the forecast part and the target when they are missing", () => {
    expect(
      paceDetailText(
        view({ forecast: null, low: null, high: null, target: null }),
      ),
    ).toBe("October 2026 so far: 4,120");
  });

  it("says 'No forecast yet' for the unknown pace", () => {
    const html = render({
      view: view({
        pace: "unknown",
        label: paceLabel("unknown"),
        tone: "neutral",
        forecast: null,
        low: null,
        high: null,
        basis: "short_history",
      }),
      detailed: true,
    });
    expect(html).toContain("No forecast yet");
    expect(html).not.toContain("forecast 8");
  });
});
