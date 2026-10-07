import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BQ_BADGE_LABEL } from "@/lib/seo/agency/copy";
import {
  BQ_REMOVE_NOTE,
  BQ_SETUP_STEPS,
  BQ_SOURCE_ERROR_TEXT,
  type BqVerifyResult,
} from "@/lib/seo/agency/bq/copy";
import type { BqBadge } from "@/lib/seo/agency/types";
import type { BqSourceView } from "@/server/seo/agency/bq/source";

// Bu dosyanın kanıtladığı (SC-F9 BigQuery kartı): sunucuda anahtar yoksa ve
// kullanıcı mülk sahibi değilse form çıkmaz; kaynak yokken kurulum adımları,
// servis hesabı e-postası ve form çıkar; kaynak varken her durum rozeti,
// kullanım çubuğu, mutabakat satırı ve yalnız sabit hata metni çıkar; doğrulama
// adımları metin durumlarıyla yazılır; kaldırma onayı BQ_REMOVE_NOTE içerir.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/gsc-bigquery-actions", () => ({
  saveBigQuerySourceAction: vi.fn(),
  verifyBigQuerySourceAction: vi.fn(),
  setBigQueryStateAction: vi.fn(),
}));

const { BigQueryCard } = await import("./bigquery-card");
const { VerifySteps } = await import("./bigquery-setup-form");

const GIB = 1024 ** 3;

function view(overrides: Partial<BqSourceView> = {}): BqSourceView {
  return {
    linkId: "l1",
    siteUrl: "https://a.example/",
    status: "OFF",
    configured: true,
    isOwner: true,
    serviceAccountEmail: "reader@agentelse.iam.gserviceaccount.com",
    bqProjectId: null,
    dataset: null,
    location: null,
    exportStart: null,
    exportedThrough: null,
    importAll: false,
    maxBytesPerQuery: 10 * GIB,
    monthlyBudgetBytes: 300 * GIB,
    usedBytesMonth: 0,
    queriesMonth: 0,
    lastVerifiedAt: null,
    lastSyncAt: null,
    lastError: null,
    errorText: null,
    imported: { weeks: 0, months: 0, lastWeek: null },
    completeWeeks: 0,
    reconcile: null,
    ...overrides,
  };
}

function active(overrides: Partial<BqSourceView> = {}): BqSourceView {
  return view({
    status: "ACTIVE",
    bqProjectId: "my-project-123",
    dataset: "searchconsole",
    exportStart: "2026-06-01",
    exportedThrough: "2026-10-03",
    imported: { weeks: 12, months: 3, lastWeek: "2026-09-21" },
    completeWeeks: 20,
    ...overrides,
  });
}

function render(
  source: BqSourceView,
  options: { isManager?: boolean; defaultOpen?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(BigQueryCard, {
      projectId: "p1",
      linkId: "l1",
      view: source,
      isManager: options.isManager ?? true,
      defaultOpen: options.defaultOpen,
    }),
  );
}

describe("BigQueryCard", () => {
  it("sunucuda anahtar yoksa sabit mesajı gösterir, form yok", () => {
    const html = render(view({ configured: false }));
    expect(html).toContain("BigQuery export isn&#x27;t available on this server yet.");
    expect(html).not.toContain("<form");
  });

  it("mülk sahibi değilse NOT_OWNER metnini gösterir, form yok", () => {
    const html = render(view({ isOwner: false }));
    expect(html).toContain(BQ_SOURCE_ERROR_TEXT.NOT_OWNER);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("bqProjectId");
  });

  it("kaynak yokken kurulum adımlarını, servis hesabını ve formu gösterir", () => {
    const html = render(view());
    for (const step of BQ_SETUP_STEPS) {
      expect(html).toContain(step.replace(/'/g, "&#x27;"));
    }
    expect(html).toContain("reader@agentelse.iam.gserviceaccount.com");
    expect(html).toContain("Copy");
    expect(html).toContain('name="bqProjectId"');
    expect(html).toContain('value="searchconsole"');
    expect(html).toContain("Also replace complete weeks");
  });

  it("kaynak yokken yönetmeyen kullanıcı form görmez", () => {
    const html = render(view(), { isManager: false });
    expect(html).toContain("reader@agentelse.iam.gserviceaccount.com");
    expect(html).not.toContain('name="bqProjectId"');
    expect(html).toContain("Ask a workspace admin");
  });

  it("defaultOpen yalnız verilince <details open> yazar", () => {
    expect(render(view(), { defaultOpen: true })).toMatch(/<details[^>]*open/);
    expect(render(view())).not.toMatch(/<details[^>]*\sopen/);
  });

  it.each(["DRAFT", "VERIFIED", "ACTIVE", "PAUSED", "ERROR", "BUDGET"] as BqBadge[])(
    "%s durumunda rozet metnini yazar",
    (status) => {
      const html = render(active({ status, bqProjectId: "my-project-123" }));
      expect(html).toContain(BQ_BADGE_LABEL[status]);
    },
  );

  it("kullanım çubuğu yüzdeyi ve baytları gösterir", () => {
    const html = render(
      active({ usedBytesMonth: 75 * GIB, monthlyBudgetBytes: 300 * GIB }),
    );
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("width:25%");
    expect(html).toContain("Used this month");
  });

  it("pencere, içe aktarılan dönemler ve tam veri haftaları yazılır", () => {
    const html = render(active());
    expect(html).toContain("Jun 1, 2026 to Oct 3, 2026");
    expect(html).toContain("12 weeks, 3 months");
    expect(html).toContain("Complete data for 20 weeks");
  });

  it("mutabakat satırı farkları mutlak değerle yazar", () => {
    const html = render(
      active({
        reconcile: {
          days: 14,
          clicksDiffPct: -1.24,
          impressionsDiffPct: 0.8,
          checkedAt: "2026-10-05T10:00:00.000Z",
        },
      }),
    );
    expect(html).toContain("over 14 days");
    expect(html).toContain("clicks 1.2%");
    expect(html).toContain("impressions 0.8%");
  });

  it("hata metni yalnız sabit metinden gelir", () => {
    const fixed = active({
      status: "ERROR",
      lastError: "NO_ACCESS",
      errorText: BQ_SOURCE_ERROR_TEXT.NO_ACCESS,
    });
    expect(render(fixed)).toContain(
      BQ_SOURCE_ERROR_TEXT.NO_ACCESS.replace(/'/g, "&#x27;"),
    );
    // errorText yoksa kod üzerinden sabit metne düşer; ham ileti yoktur.
    const byCode = render(
      active({ status: "ERROR", lastError: "SITE_MISMATCH", errorText: null }),
    );
    expect(byCode).toContain(
      BQ_SOURCE_ERROR_TEXT.SITE_MISMATCH.replace(/'/g, "&#x27;"),
    );
  });

  it("durum düğmeleri: ACTIVE Pause, VERIFIED Turn on, kaldırma notu", () => {
    const on = render(active({ status: "ACTIVE" }));
    expect(on).toContain("Pause");
    expect(on).not.toContain("Turn on");
    const ready = render(active({ status: "VERIFIED" }));
    expect(ready).toContain("Turn on");
    expect(ready).toContain("Verify");
    expect(ready).toContain(BQ_REMOVE_NOTE);
  });

  it("yönetmeyen kullanıcı kaynak varken kontrol görmez", () => {
    const html = render(active(), { isManager: false });
    expect(html).not.toContain("Verify");
    expect(html).not.toContain("Pause");
    expect(html).toContain("Used this month");
  });
});

describe("VerifySteps", () => {
  const result: BqVerifyResult = {
    ok: false,
    errorCode: "SITE_MISMATCH",
    steps: [
      { key: "ownership", label: "Property ownership", state: "ok", detail: null },
      { key: "dataset", label: "Dataset", state: "warn", detail: "Slow response" },
      { key: "site_match", label: "Site match", state: "fail", detail: null },
      { key: "reconcile", label: "Totals match the API", state: "skipped", detail: null },
    ],
  };

  it("her adımı rol=list içinde metin durumuyla yazar", () => {
    const html = renderToStaticMarkup(createElement(VerifySteps, { result }));
    expect(html).toContain('role="list"');
    expect(html).toContain("Property ownership");
    for (const text of ["OK", "Check", "Failed", "Skipped"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Slow response");
  });

  it("başarısızlıkta yalnız sabit hata metnini yazar", () => {
    const html = renderToStaticMarkup(createElement(VerifySteps, { result }));
    expect(html).toContain(
      BQ_SOURCE_ERROR_TEXT.SITE_MISMATCH.replace(/'/g, "&#x27;"),
    );
    const ok = renderToStaticMarkup(
      createElement(VerifySteps, {
        result: { ...result, ok: true, errorCode: null },
      }),
    );
    expect(ok).not.toContain(BQ_SOURCE_ERROR_TEXT.SITE_MISMATCH);
  });
});
