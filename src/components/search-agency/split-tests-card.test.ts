import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SPLIT_ERROR_TEXT } from "@/lib/seo/agency/split/assign";
import { splitHeadline } from "@/lib/seo/agency/split/copy";
import type {
  SplitEvaluation,
  SplitStatus,
  SplitTestView,
} from "@/lib/seo/agency/split/types";

// Bu dosyanın kanıtladığı (SC-F9 Split SEO tests kartı): duruma göre doğru
// adım düğmesi; "Apply with approval" yalnız canApplyViaCms ve applyReady
// birlikteyken; "Check now" yalnız crawlerVerifiable testte; ikincil site
// notu; sonuç başlığı ve ayrıntısı sabit şablonlardan; uygunluk iletisi sabit
// metinlerden; form 100 sayfa şartını ve grup sınırını açıklar.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/gsc-split-test-actions", () => ({
  previewSplitPopulationAction: vi.fn(),
  createSplitTestAction: vi.fn(),
  markSplitTestAppliedAction: vi.fn(),
  applySplitTestViaCmsAction: vi.fn(),
  cancelSplitTestAction: vi.fn(),
  checkSplitTestNowAction: vi.fn(),
}));

const { SplitTestsCard } = await import("./split-tests-card");
const { PopulationPreview, SplitTestForm } = await import("./split-test-form");

function evaluation(overrides: Partial<SplitEvaluation> = {}): SplitEvaluation {
  return {
    v: 1,
    method: "DID",
    metric: "clicks",
    anchorDay: "2026-09-01",
    preWeeks: [],
    postWeeks: [],
    testPages: 120,
    controlPages: 118,
    usedTest: 110,
    usedControl: 108,
    excluded: 0,
    effect: 0.123,
    low: 0.05,
    high: 0.2,
    placebo: null,
    treated: null,
    control: null,
    updates: [],
    truncated: false,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function test(
  status: SplitStatus,
  overrides: Partial<SplitTestView> = {},
): SplitTestView {
  return {
    id: `t_${status}`,
    projectId: "p1",
    linkId: "l1",
    isMock: false,
    isSecondarySite: false,
    name: `Test ${status}`,
    changeKind: "TITLE_META",
    description: null,
    status,
    pageGroups: ["/blog"],
    capped: false,
    arms: { test: 120, control: 118 },
    perGroup: [{ group: "/blog", test: 120, control: 118 }],
    balance: { testClicks: 900, controlClicks: 880, ratio: 0.98, recommended: true },
    change: { titlePattern: "{title} | {site}", metaPattern: null, schemaType: null, note: null },
    appliedVia: null,
    appliedAt: null,
    cms: null,
    verification: null,
    measureFrom: null,
    evaluateAfter: null,
    windowDays: 28,
    evaluation: null,
    outcome: null,
    confidence: null,
    evaluatedAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    canApplyViaCms: false,
    crawlerVerifiable: false,
    ...overrides,
  };
}

function render(
  tests: SplitTestView[],
  options: { applyReady?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(SplitTestsCard, {
      projectId: "p1",
      linkId: "l1",
      tests,
      groups: [
        { group: "/blog", pages: 420 },
        { group: "/shop", pages: 180 },
      ],
      applyReady: options.applyReady ?? false,
    }),
  );
}

describe("SplitTestsCard adımları", () => {
  it("DRAFT: I applied it, talimatlar ve iptal; kontrol düğmesi yok", () => {
    const html = render([test("DRAFT")]);
    expect(html).toContain("I applied it");
    expect(html).toContain('name="appliedOn"');
    expect(html).toContain("Change the title or description only on the test pages.");
    expect(html).toContain("Cancel test");
    expect(html).not.toContain("Check now");
    expect(html).toContain("Ready to apply");
  });

  it("APPLIED: I applied it yok; Check now yalnız crawlerVerifiable", () => {
    const plain = render([test("APPLIED")]);
    expect(plain).not.toContain("I applied it");
    expect(plain).not.toContain("Check now");
    expect(plain).toContain("Waiting for the change");
    const crawler = render([test("APPLIED", { crawlerVerifiable: true })]);
    expect(crawler).toContain("Check now");
  });

  it("APPLIED: doğrulama kontrolleri, CMS sayıları ve neden metni yazılır", () => {
    const html = render([
      test("APPLIED", {
        appliedVia: "CMS",
        cms: { total: 40, verified: 12, failed: 1, waiting: 27 },
        verification: {
          v: 1,
          attempts: 2,
          lastCheckedAt: null,
          method: "CMS",
          reason: "CMS_CHANGE_FAILED",
          checks: [{ key: "title", label: "Title changed", ok: false, observed: null }],
        },
      }),
    ]);
    expect(html).toContain("12 of 40 pages confirmed");
    expect(html).toContain("27 waiting");
    expect(html).toContain("1 failed");
    expect(html).toContain("Title changed");
    expect(html).toContain("Some approved changes failed or were rejected.");
  });

  it("EVALUATING: ölçüm bitiş tarihini yazar", () => {
    const html = render([
      test("EVALUATING", { evaluateAfter: "2026-11-04", measureFrom: "2026-10-07" }),
    ]);
    expect(html).toContain("Measuring until Nov 4, 2026");
    expect(html).toContain("Cancel test");
  });

  it("sonuç: başlık ve ayrıntı sabit şablondan, iptal düğmesi yok", () => {
    const evalResult = evaluation();
    const html = render([test("WORKED", { evaluation: evalResult })]);
    expect(html).toContain(splitHeadline(evalResult));
    expect(html).toContain("+12.3%");
    expect(html).toContain("We compared 110 test pages with 108 control pages.");
    expect(html).toContain("placebo check");
    expect(html).not.toContain("Cancel test");
  });

  it("CANCELLED ve EXPIRED sonuç ya da düğme yazmaz", () => {
    const html = render([test("CANCELLED"), test("EXPIRED")]);
    expect(html).toContain("Cancelled");
    expect(html).toContain("Expired");
    expect(html).not.toContain("Cancel test");
    expect(html).not.toContain("I applied it");
  });

  it("kollar ve grup başına sayılar yazılır", () => {
    const html = render([test("DRAFT")]);
    expect(html).toContain("120 test pages and 118 control pages");
    expect(html).toContain("/blog: 120 test, 118 control");
  });
});

describe("CMS yolu ve ikincil site", () => {
  const cms = test("DRAFT", { canApplyViaCms: true });

  it("Apply with approval yalnız canApplyViaCms ve applyReady birlikteyken çıkar", () => {
    const on = render([cms], { applyReady: true });
    expect(on).toContain("Apply with approval");
    expect(on).toContain("Each page needs its own approval.");
    expect(render([cms], { applyReady: false })).not.toContain(
      "Apply with approval",
    );
    expect(
      render([test("DRAFT", { canApplyViaCms: false })], { applyReady: true }),
    ).not.toContain("Apply with approval");
  });

  it("CMS düğmesi DRAFT dışında çıkmaz", () => {
    expect(
      render([test("APPLIED", { canApplyViaCms: true })], { applyReady: true }),
    ).not.toContain("Apply with approval");
  });

  it("ikincil site testinde elle onay notu çıkar", () => {
    const html = render([test("DRAFT", { isSecondarySite: true })]);
    expect(html).toContain(
      "Changes on secondary sites are confirmed by you, not checked automatically.",
    );
    expect(render([test("DRAFT")])).not.toContain("secondary sites are confirmed");
  });
});

describe("liste ve form", () => {
  it("test yokken boş durum ve form çıkar", () => {
    const html = render([]);
    expect(html).toContain("No split tests yet.");
    expect(html).toContain("New split test");
    expect(html).toContain("None yet");
  });

  it("form 100 sayfa şartını, grup sınırını ve grup onay kutularını açıklar", () => {
    const html = renderToStaticMarkup(
      createElement(SplitTestForm, {
        projectId: "p1",
        linkId: "l1",
        groups: [
          { group: "/blog", pages: 420 },
          { group: "/shop", pages: 180 },
        ],
      }),
    );
    expect(html).toContain("at least 100 pages with search traffic");
    expect(html).toContain("0 of 5 chosen");
    expect(html).toContain("/blog");
    expect(html).toContain("420 pages");
    expect(html).toContain("Title pattern");
    // Önizleme olmadan Create kapalıdır.
    const create = html
      .split("<button")
      .slice(1)
      .find((part) => part.split("</button>")[0]?.includes("Create test"));
    expect(create).toContain('disabled=""');
  });
});

describe("PopulationPreview", () => {
  it("uygun nüfus: sayfa sayısı, kol dağılımı ve tavsiye notu", () => {
    const html = renderToStaticMarkup(
      createElement(PopulationPreview, {
        preview: {
          state: "ready",
          pages: 238,
          capped: false,
          groups: [{ group: "/blog", pages: 238 }],
          eligibility: {
            ok: true,
            arms: { test: 119, control: 119 },
            perGroup: [{ group: "/blog", test: 119, control: 119 }],
            recommended: true,
          },
        },
      }),
    );
    expect(html).toContain("238");
    expect(html).toContain("split into two groups");
    expect(html).toContain("/blog: 119 test, 119 control");
    expect(html).toContain("Recommended size");
  });

  it("küçük nüfus: önerilmez notu; kırpılmışsa üst sınır yazılır", () => {
    const html = renderToStaticMarkup(
      createElement(PopulationPreview, {
        preview: {
          state: "ready",
          pages: 4000,
          capped: true,
          groups: [],
          eligibility: {
            ok: true,
            arms: { test: 60, control: 60 },
            perGroup: [],
            recommended: false,
          },
        },
      }),
    );
    expect(html).toContain("Smaller than recommended");
    expect(html).toContain("Only the 4000 pages");
  });

  it("uygun değilse sabit hata metnini yazar", () => {
    for (const reason of ["NO_HISTORY", "TOO_FEW_PAGES", "LOW_TRAFFIC"] as const) {
      const html = renderToStaticMarkup(
        createElement(PopulationPreview, {
          preview: {
            state: "ready",
            pages: 0,
            capped: false,
            groups: [],
            eligibility: { ok: false, reason },
          },
        }),
      );
      expect(html).toContain(SPLIT_ERROR_TEXT[reason].replace(/'/g, "&#x27;"));
    }
  });

  it("boşta, yükleniyor ve hata durumlarını yazar", () => {
    const idle = renderToStaticMarkup(
      createElement(PopulationPreview, { preview: { state: "idle" } }),
    );
    expect(idle).toContain("Choose 1 to 5 page groups");
    const loading = renderToStaticMarkup(
      createElement(PopulationPreview, { preview: { state: "loading" } }),
    );
    expect(loading).toContain("Checking pages...");
    const failed = renderToStaticMarkup(
      createElement(PopulationPreview, {
        preview: { state: "error", message: "Not available" },
      }),
    );
    expect(failed).toContain("Not available");
  });
});
