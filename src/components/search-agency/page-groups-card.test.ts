import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_PAGE_GROUP_RULES } from "@/lib/seo/agency/page-groups";
import type {
  PageGroupPreview,
  PageGroupRule,
} from "@/lib/seo/agency/page-groups";
import type { PageGroupState } from "@/server/seo/agency/page-groups";

// Bu dosyanın kanıtladığı (SC-F9 Page groups kartı): uygulanırken "Applying to
// your pages..." durumu; yönetmeyen kullanıcıda salt okunur kural listesi ve
// düzenleyici yok; yöneticide kural satırları, kaydet formu ve 40 kural sınırı;
// önizleme tablosu gruplar, örnekler ve "n pages would move" satırını yazar.

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

const { PageGroupsCard } = await import("./page-groups-card");
const { PageGroupsEditor, PreviewTable } = await import("./page-groups-editor");

function rule(n: number, overrides: Partial<PageGroupRule> = {}): PageGroupRule {
  return {
    id: `r${n}`,
    group: `/group${n}`,
    match: "PREFIX",
    pattern: `/group${n}`,
    ...overrides,
  };
}

function state(
  rules: PageGroupRule[] = [],
  overrides: Partial<PageGroupState> = {},
): PageGroupState {
  return {
    rules: rules.length > 0 ? { v: 1, rules } : EMPTY_PAGE_GROUP_RULES,
    version: rules.length > 0 ? 1 : 0,
    appliedVersion: rules.length > 0 ? 1 : 0,
    applying: false,
    appliedWeek: null,
    ...overrides,
  };
}

const groups = [
  { group: "/blog", pages: 420 },
  { group: "/shop", pages: 180 },
];

function render(
  pageState: PageGroupState,
  isManager: boolean,
): string {
  return renderToStaticMarkup(
    createElement(PageGroupsCard, {
      projectId: "p1",
      linkId: "l1",
      state: pageState,
      groups,
      isManager,
    }),
  );
}

// Etiketi içeren düğmenin açılış etiketini döndürür (komşu düğmelere taşmaz).
function buttonTag(html: string, label: string): string {
  const chunk = html
    .split("<button")
    .slice(1)
    .find((part) => (part.split("</button>")[0] ?? "").includes(label));
  if (!chunk) throw new Error(`no button labelled ${label}`);
  return "<button" + chunk.slice(0, chunk.indexOf(">") + 1);
}

describe("PageGroupsCard", () => {
  it("uygulanırken durum metnini gösterir, uygulanmıyorsa göstermez", () => {
    expect(render(state([rule(1)], { applying: true }), true)).toContain(
      "Applying to your pages...",
    );
    expect(render(state([rule(1)]), true)).not.toContain(
      "Applying to your pages...",
    );
  });

  it("mevcut grupları sayfa sayılarıyla listeler", () => {
    const html = render(state(), true);
    expect(html).toContain("/blog · 420");
    expect(html).toContain("/shop · 180");
  });

  it("yönetmeyen kullanıcıda kurallar salt okunur, düzenleyici ve kaydet yok", () => {
    const html = render(
      state([rule(1, { match: "GLOB", pattern: "/shop/*/reviews", group: "/reviews" })]),
      false,
    );
    expect(html).toContain('data-state="read-only"');
    expect(html).toContain("/reviews");
    expect(html).toContain("Pattern (* and **)");
    expect(html).toContain("/shop/*/reviews");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Add rule");
    expect(html).toContain("Ask a workspace admin");
  });

  it("yöneticide kural satırları, Preview, Save ve gizli rules alanı vardır", () => {
    const html = render(state([rule(1), rule(2)]), true);
    expect(html).toContain("Rule 1 group name");
    expect(html).toContain("Rule 2 path pattern");
    expect(html).toContain("Add rule");
    expect(html).toContain("Preview");
    expect(html).toContain("Save");
    expect(html).toContain('name="rules"');
    expect(html).toContain("2 rules");
  });

  it("kural yokken ilk yol parçası notunu yazar", () => {
    expect(render(state(), true)).toContain(
      "Pages are grouped by their first path segment.",
    );
  });
});

describe("PageGroupsEditor", () => {
  it("40 kuralda Add rule kapalıdır ve sınır yazılır", () => {
    const rules = Array.from({ length: 40 }, (_, i) => rule(i + 1));
    const html = renderToStaticMarkup(
      createElement(PageGroupsEditor, {
        projectId: "p1",
        linkId: "l1",
        initialRules: rules,
      }),
    );
    expect(html).toContain("Up to 40 rules.");
    expect(buttonTag(html, "Add rule")).toContain('disabled=""');
  });

  it("40 kuraldan azında Add rule açıktır", () => {
    const html = renderToStaticMarkup(
      createElement(PageGroupsEditor, {
        projectId: "p1",
        linkId: "l1",
        initialRules: [rule(1)],
      }),
    );
    expect(html).not.toContain("Up to 40 rules.");
    expect(buttonTag(html, "Add rule")).not.toContain('disabled=""');
  });

  it("geçersiz satırda uyarı çıkar ve Save kapanır", () => {
    const html = renderToStaticMarkup(
      createElement(PageGroupsEditor, {
        projectId: "p1",
        linkId: "l1",
        initialRules: [rule(1, { group: "blog" })],
      }),
    );
    expect(html).toContain("Group names start with /");
    expect(buttonTag(html, "Save")).toContain('disabled=""');
  });
});

describe("PreviewTable", () => {
  const preview: PageGroupPreview = {
    groups: [
      { group: "/reviews", pages: 90, samples: ["/shop/a/reviews", "/shop/b/reviews"] },
      { group: "/blog", pages: 420, samples: ["/blog/x"] },
    ],
    changed: 90,
    unmatched: 3,
    sampled: 600,
  };

  it("grupları, sayfa sayılarını, örnekleri ve taşınacak sayfa sayısını yazar", () => {
    const html = renderToStaticMarkup(createElement(PreviewTable, { preview }));
    expect(html).toContain("90");
    expect(html).toContain("pages would move");
    expect(html).toContain("from 600 sampled");
    expect(html).toContain("3 not matched by a rule");
    expect(html).toContain("/shop/a/reviews, /shop/b/reviews");
    expect(html).toContain("/blog");
  });

  it("tek sayfa için tekil yazar, grup yoksa ipucu çıkar", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewTable, {
        preview: { groups: [], changed: 1, unmatched: 0, sampled: 0 },
      }),
    );
    expect(html).toContain("page would move");
    expect(html).not.toContain("pages would move");
    expect(html).toContain("No pages to preview yet.");
  });
});
