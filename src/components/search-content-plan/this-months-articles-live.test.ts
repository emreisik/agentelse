import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ContentPlanView } from "@/server/seo/content-plan/store";

// Bu dosyanın kanıtladığı (SC-F7 canlı blok): saf görünüm idle, loading,
// error, off durumlarında, plan yokken, plan hazır değilken ve ay
// uyuşmazlığında fallback'i aynen çizer; yalnız ay şimdiki yerel aya eşit ve
// plan hazırsa kompakt listeyi çizer.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-content-plan-actions", () => ({
  planThisMonthAction: vi.fn(),
  refreshPlanAction: vi.fn(),
  skipSlotAction: vi.fn(),
  replaceSlotAction: vi.fn(),
  moveSlotAction: vi.fn(),
  savePlanSettingsAction: vi.fn(),
}));

const { ThisMonthsArticlesLiveView } = await import(
  "./this-months-articles-live"
);

const FALLBACK = "SNAPSHOT-FALLBACK";

function plan(overrides: Partial<ContentPlanView> = {}): ContentPlanView {
  return {
    projectId: "p1",
    month: "2026-10",
    monthLabel: "October 2026",
    settings: { monthlyCap: 4, autoPlan: true },
    state: "ready",
    emptyReason: null,
    emptyText: "",
    cap: 4,
    used: 1,
    planned: 1,
    slots: [
      {
        id: "s1",
        state: "PLANNED",
        stateLabel: "Planned",
        kind: "SUPPORT",
        title: "Live plan article",
        keyword: "running shoes",
        date: "2026-10-14",
        time: "10:00",
        dateLabel: "Oct 14",
        why: [],
        linkFrom: [],
        linkTo: [],
        linksVerified: true,
        ideaId: "i1",
        creativeId: "c1",
        postId: "po1",
        writeHref: "/projects/p1?module=seo&idea=i1",
        continueHref: null,
        canWrite: true,
        canContinue: false,
        canSkip: true,
        canMove: true,
        canReplace: true,
      },
    ],
    pillars: [],
    basedOnWeek: "2026-09-21",
    wording: "AI",
    wordingNote: null,
    regenerationsLeft: 3,
    notes: [],
    isMock: false,
    canPlanNow: false,
    canRefresh: true,
    ...overrides,
  } as ContentPlanView;
}

function render(
  state: Parameters<typeof ThisMonthsArticlesLiveView>[0]["state"],
  month = "2026-10",
) {
  return renderToStaticMarkup(
    createElement(ThisMonthsArticlesLiveView, {
      state,
      month,
      projectId: "p1",
      fallback: createElement("p", null, FALLBACK),
    }),
  );
}

describe("ThisMonthsArticlesLiveView", () => {
  it.each(["idle", "loading", "error", "off"] as const)(
    "%s durumunda fallback'i çizer",
    (state) => {
      const html = render(state);
      expect(html).toContain(FALLBACK);
      expect(html).not.toContain("Live plan article");
    },
  );

  it("plan yoksa fallback'i çizer", () => {
    const html = render({ plan: null, currentMonth: "2026-10" });
    expect(html).toContain(FALLBACK);
  });

  it("plan hazır değilse fallback'i çizer", () => {
    const html = render({
      plan: plan({ state: "empty", slots: [] }),
      currentMonth: "2026-10",
    });
    expect(html).toContain(FALLBACK);
  });

  it("ay uyuşmazlığında (geçmiş yol haritası) fallback kalır", () => {
    const html = render({ plan: plan(), currentMonth: "2026-11" }, "2026-10");
    expect(html).toContain(FALLBACK);
    expect(html).not.toContain("Live plan article");
  });

  it("hazır plan ve eşleşen ayda kompakt listeyi çizer", () => {
    const html = render({ plan: plan(), currentMonth: "2026-10" });
    expect(html).not.toContain(FALLBACK);
    expect(html).toContain("Live plan article");
    expect(html).toContain("Open plan");
    expect(html).toContain('data-live="true"');
    // Kompakt: menü yok.
    expect(html).not.toContain('aria-label="More actions"');
  });
});
