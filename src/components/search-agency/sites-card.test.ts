import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSiteView } from "@/lib/seo/agency/types";

// Bu dosyanın kanıtladığı (SC-F9 Sites kartı): ekleme formu adayları listeler;
// 5 sitede sınır iletisi çıkar ve form yoktur; kaldır / "Make primary" yalnız
// ikincil sitelerde ve yöneticiye görünür; yönetmeyen kullanıcı salt okunur
// görür.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/gsc-sites-actions", () => ({
  addSecondarySiteAction: vi.fn(),
  removeSecondarySiteAction: vi.fn(),
  makePrimarySiteAction: vi.fn(),
  savePageGroupRulesAction: vi.fn(),
  previewPageGroupRulesAction: vi.fn(),
}));

const { SitesCard } = await import("./sites-card");

function site(overrides: Partial<ProjectSiteView>): ProjectSiteView {
  return {
    linkId: "l1",
    siteUrl: "https://a.example/",
    siteLabel: "a.example",
    role: "PRIMARY",
    isMock: false,
    health: "OK",
    lastFinalDate: "2026-10-03",
    backfillDone: true,
    bigQuery: "OFF",
    isOwner: true,
    ...overrides,
  };
}

const primary = site({});
const secondary = site({
  linkId: "l2",
  siteUrl: "https://b.example/",
  siteLabel: "b.example",
  role: "SECONDARY",
});
const candidates = [
  { siteUrl: "https://c.example/", siteLabel: "c.example", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:d.example", siteLabel: "d.example", permissionLevel: "siteFullUser" },
];

function render(
  sites: ProjectSiteView[],
  options: { isManager?: boolean; candidates?: typeof candidates } = {},
): string {
  return renderToStaticMarkup(
    createElement(SitesCard, {
      projectId: "p1",
      sites,
      candidates: options.candidates ?? candidates,
      isManager: options.isManager ?? true,
    }),
  );
}

describe("SitesCard", () => {
  it("site sayısını ve her sitenin rozetini gösterir", () => {
    const html = render([primary, secondary]);
    expect(html).toContain("2 of 5 sites");
    expect(html).toContain("Primary");
    expect(html).toContain("Secondary");
    expect(html).toContain("Data through Oct 3, 2026");
  });

  it("ekleme formu adayları seçenek olarak listeler", () => {
    const html = render([primary]);
    expect(html).toContain('name="siteUrl"');
    expect(html).toContain("c.example");
    expect(html).toContain("d.example");
    expect(html).toContain("Add site");
  });

  it("aday yoksa form yerine açıklama çıkar", () => {
    const html = render([primary], { candidates: [] });
    expect(html).not.toContain('name="siteUrl"');
    expect(html).toContain("No other verified sites");
  });

  it("5 sitede sınır iletisi çıkar ve ekleme formu yoktur", () => {
    const sites = [
      primary,
      ...[2, 3, 4, 5].map((n) =>
        site({
          linkId: `l${n}`,
          siteUrl: `https://s${n}.example/`,
          siteLabel: `s${n}.example`,
          role: "SECONDARY",
        }),
      ),
    ];
    const html = render(sites);
    expect(html).toContain("5 of 5 sites");
    expect(html).toContain("A project can track up to 5 Search Console sites.");
    expect(html).not.toContain('name="siteUrl"');
  });

  it("kaldır ve Make primary yalnız ikincil sitelerde, yöneticiye çıkar", () => {
    const html = render([primary, secondary]);
    expect(html.match(/Make primary/g)).toHaveLength(1);
    expect(html.match(/Remove site/g)).toHaveLength(1);
    const primaryOnly = render([primary]);
    expect(primaryOnly).not.toContain("Make primary");
    expect(primaryOnly).not.toContain("Remove site");
  });

  it("make-primary metni sağlık, fırsat, rapor ve uyarıların taşındığını söyler", () => {
    expect(render([primary, secondary])).toContain(
      "health checks, opportunities, reports and alerts",
    );
  });

  it("yönetmeyen kullanıcı salt okunur görür", () => {
    const html = render([primary, secondary], { isManager: false });
    expect(html).toContain("b.example");
    expect(html).not.toContain("Make primary");
    expect(html).not.toContain("Remove site");
    expect(html).not.toContain('name="siteUrl"');
    expect(html).toContain("Ask a workspace admin");
  });
});
