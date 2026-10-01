import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkReturnLink, WorkReturnLinks } from "./work-return-link";

describe("WorkReturnLinks", () => {
  it("renders a row with the connected line and a Back link", () => {
    const html = renderToStaticMarkup(
      createElement(WorkReturnLinks, {
        projectId: "p1",
        links: [{ channel: "instagram", workId: "w 1/x", title: "Spring launch" }],
      }),
    );
    expect(html).toContain("Instagram is connected.");
    expect(html).toContain("Back to Spring launch");
    expect(html).toContain('href="/projects/p1?work=w%201%2Fx"');
    expect(html).toContain("min-h-11");
  });

  it("uses the generic label for an empty title", () => {
    const html = renderToStaticMarkup(
      createElement(WorkReturnLinks, {
        projectId: "p1",
        links: [{ channel: "x", workId: "w", title: "  " }],
      }),
    );
    expect(html).toContain("Back to your Work");
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(createElement(WorkReturnLinks, { projectId: "p1", links: [] }))).toBe("");
  });

  it("single variant links to the Work", () => {
    const html = renderToStaticMarkup(
      createElement(WorkReturnLink, { projectId: "p1", workId: "w2", title: "Plan" }),
    );
    expect(html).toContain('href="/projects/p1?work=w2"');
    expect(html).toContain("Back to Plan");
  });
});
