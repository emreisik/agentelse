import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProjectSiteView } from "@/lib/seo/agency/types";

import { SiteSwitcher } from "./site-switcher";

// Bu dosyanın kanıtladığı: tek sitede hiçbir şey çizilmez; birincil çip
// parametresiz, ikincil çip ?site= ile gider ve diğer parametreleri korur;
// görüntülenen çipte aria-current; "Secondary" rozeti ve sağlık metni.

function site(overrides: Partial<ProjectSiteView>): ProjectSiteView {
  return {
    linkId: "l1",
    siteUrl: "https://a.example/",
    siteLabel: "a.example",
    role: "PRIMARY",
    isMock: false,
    health: "OK",
    lastFinalDate: null,
    backfillDone: true,
    bigQuery: "OFF",
    isOwner: true,
    ...overrides,
  };
}

const primarySite = site({});
const sites = [
  primarySite,
  site({
    linkId: "l2",
    siteUrl: "https://b.example/",
    siteLabel: "b.example",
    role: "SECONDARY",
    health: "DEGRADED",
  }),
];

function render(
  overrides: Partial<Parameters<typeof SiteSwitcher>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SiteSwitcher, {
      projectId: "p1",
      sites,
      viewedLinkId: null,
      base: "/projects/p1/arama",
      ...overrides,
    }),
  );
}

// aria-current taşıyan bağlantının içeriği.
function currentChip(html: string): string {
  const part = html
    .split("<a ")
    .find((chunk) => chunk.includes('aria-current="page"'));
  return part ? (part.split("</a>")[0] ?? "") : "";
}

describe("SiteSwitcher", () => {
  it("tek sitede hiçbir şey çizmez", () => {
    expect(render({ sites: [primarySite] })).toBe("");
    expect(render({ sites: [] })).toBe("");
  });

  it("birincil çip parametresiz, ikincil çip ?site= ile gider", () => {
    const html = render();
    expect(html).toContain('href="/projects/p1/arama"');
    expect(html).toContain('href="/projects/p1/arama?site=l2"');
  });

  it("diğer adres parametrelerini korur ve birincile site yazmaz", () => {
    const html = render({ keep: { period: "28d", q: "" } });
    expect(html).toContain('href="/projects/p1/arama?period=28d"');
    expect(html).toContain('href="/projects/p1/arama?site=l2&amp;period=28d"');
  });

  it("görüntülenen çipte aria-current vardır, tek çipte", () => {
    const secondary = render({ viewedLinkId: "l2" });
    expect(secondary.match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentChip(secondary)).toContain("b.example");
    // viewedLinkId yokken birincil seçili sayılır.
    expect(render().match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentChip(render())).toContain("a.example");
  });

  it("ikincil rozetini ve sağlık metnini gösterir", () => {
    const html = render();
    expect(html).toContain("Secondary");
    expect(html).toContain('aria-label="Syncing"');
    expect(html).toContain('aria-label="Updates failing"');
  });
});
