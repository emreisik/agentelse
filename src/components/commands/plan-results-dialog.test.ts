import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/plan-progress-actions", () => ({
  getPlanResultsAction: vi.fn(),
}));

const { PlanResultsList } = await import("./plan-results-dialog");

const result = (over: Record<string, unknown> = {}) => ({
  creativeId: "c1",
  title: "Clinic tour",
  where: "Instagram · Reel",
  check: "72h engagement check",
  observation: "Reach 4k, 120 saves",
  checkedAt: "2026-10-08T10:00:00.000Z",
  ...over,
});

const render = (results: ReturnType<typeof result>[]) =>
  renderToStaticMarkup(createElement(PlanResultsList, { results }));

describe("PlanResultsList", () => {
  it("shows each result as reported, with what was measured and when", () => {
    const html = render([result()]);
    expect(html).toContain("Clinic tour");
    expect(html).toContain("Instagram · Reel · 72h engagement check · 8 Oct");
    expect(html).toContain("Reach 4k, 120 saves");
  });

  it("escapes what the measurement wrote (it is data, never markup)", () => {
    const html = render([result({ observation: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("says so when there is nothing yet, without inventing anything", () => {
    expect(render([])).toContain("No results yet.");
  });
});
