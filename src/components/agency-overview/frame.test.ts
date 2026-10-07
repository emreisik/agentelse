import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { AgencyOverviewFrame, StatusDot } = await import("./frame");

// Bu dosyanın kanıtladığı: çerçeve başlığı, özet kutularını, süzgeçleri
// (etkin olan aria-current ile) ve içeriği çizer; durum noktası dört tonu
// ayırır.

const render = (props: Parameters<typeof AgencyOverviewFrame>[0]) =>
  renderToStaticMarkup(createElement(AgencyOverviewFrame, props));

const BASE = {
  title: "Websites",
  subtitle: "Every site in one place.",
  summary: [
    { label: "Sites", value: "12", hint: "9 projects" },
    { label: "Need attention", value: "3" },
  ],
  filters: [
    { key: "all", label: "All", count: 12, href: "/x", active: true },
    {
      key: "attention",
      label: "Needs attention",
      count: 3,
      href: "/x?filter=attention",
      active: false,
    },
  ],
  children: createElement("p", null, "BODY"),
};

describe("AgencyOverviewFrame", () => {
  it("renders the title, subtitle and children", () => {
    const html = render(BASE);
    expect(html).toContain("<h1");
    expect(html).toContain("Websites");
    expect(html).toContain("Every site in one place.");
    expect(html).toContain("BODY");
  });

  it("renders summary tiles with optional hints", () => {
    const html = render(BASE);
    expect(html).toContain('data-tile="Sites"');
    expect(html).toContain("12");
    expect(html).toContain("9 projects");
    expect(html).toContain('data-tile="Need attention"');
  });

  it("renders filters as links and marks only the active one", () => {
    const html = render(BASE);
    expect(html).toContain('href="/x"');
    expect(html).toContain('href="/x?filter=attention"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain("Needs attention");
  });

  it("omits the summary grid and filter bar when empty", () => {
    const html = render({ ...BASE, summary: [], filters: [] });
    expect(html).not.toContain("data-tile");
    expect(html).not.toContain("<nav");
  });

  it("renders the actions slot only when given", () => {
    expect(render(BASE)).not.toContain("ACTION");
    const html = render({ ...BASE, actions: createElement("span", null, "ACTION") });
    expect(html).toContain("ACTION");
  });

  it("has no Search Console or Analytics wording of its own", () => {
    const html = render({ ...BASE, summary: [], filters: [] });
    expect(html).not.toMatch(/Search Console|Analytics/);
  });
});

describe("StatusDot", () => {
  it("renders each tone with its label", () => {
    for (const [tone, cls] of [
      ["ok", "bg-emerald-500"],
      ["warn", "bg-amber-500"],
      ["bad", "bg-destructive"],
      ["idle", "bg-muted-foreground/40"],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(StatusDot, { tone, label: `Label ${tone}` }),
      );
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(cls);
      expect(html).toContain(`Label ${tone}`);
    }
  });
});
