import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_COPY, PLAN_COPY } from "@/lib/seo/content-plan/copy";
import type {
  ContentPlanView,
  SlotView,
} from "@/server/seo/content-plan/store";

// Bu dosyanın kanıtladığı (SC-F7 plan listesi): satırlar tarih sırasıyla,
// durum çipi ve en çok 3 "neden" satırıyla; compact kipte menü ve açılır yok;
// boş durumlar EMPTY_COPY metnini gösterir; bağlantılar doğrulanmamışsa not
// çıkar; zayıf pillar "No strong main page yet" der; iç kimlik çizilmez;
// atlanan slot soluk ve eylemsiz listelenir.

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

const { ContentPlanListView } = await import("./content-plan-list");

function slot(overrides: Partial<SlotView> = {}): SlotView {
  return {
    id: "s1",
    state: "PLANNED",
    stateLabel: "Planned",
    kind: "SUPPORT",
    title: "How to choose running shoes",
    keyword: "running shoes",
    date: "2026-10-14",
    time: "10:00",
    dateLabel: "Oct 14",
    why: [
      "About 8% of your non-brand search impressions",
      "No page on your site ranks in the top 20 for it yet",
      "Searches for it are rising",
      "A fourth line that must not show",
    ],
    linkFrom: [
      {
        url: "https://example.com/shoes",
        path: "/shoes",
        anchor: "running shoe guide",
        role: "pillar",
      },
    ],
    linkTo: [
      {
        url: "https://example.com/trail",
        path: "/trail",
        anchor: "trail options",
        role: "related",
      },
    ],
    linksVerified: true,
    ideaId: "idea-secret-1",
    creativeId: "creative-secret-1",
    postId: "post-secret-1",
    writeHref: "/projects/p1?module=seo&idea=idea-secret-1",
    continueHref: null,
    canWrite: true,
    canContinue: false,
    canSkip: true,
    canMove: true,
    canReplace: true,
    ...overrides,
  };
}

function view(overrides: Partial<ContentPlanView> = {}): ContentPlanView {
  return {
    projectId: "p1",
    month: "2026-10",
    monthLabel: "October 2026",
    settings: { monthlyCap: 4, autoPlan: true },
    state: "ready",
    emptyReason: null,
    emptyText: "",
    cap: 4,
    used: 3,
    planned: 3,
    slots: [
      slot({ id: "s2", title: "Later article", date: "2026-10-21", dateLabel: "Oct 21" }),
      slot(),
      slot({
        id: "s3",
        title: "Undated article",
        date: null,
        dateLabel: "",
        stateLabel: "Writing",
        state: "IN_PROGRESS",
      }),
    ],
    pillars: [
      {
        clusterId: "cluster-secret-1",
        name: "Running shoes",
        sharePct: 12,
        pillarPath: "/shoes",
        weak: false,
        articles: 2,
      },
    ],
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

function render(props: Parameters<typeof ContentPlanListView>[0]) {
  return renderToStaticMarkup(createElement(ContentPlanListView, props));
}

describe("ContentPlanListView", () => {
  it("başlık, ay ve kullanım satırını yazar", () => {
    const html = render({ view: view(), projectId: "p1" });
    expect(html).toContain("This month&#x27;s articles");
    expect(html).toContain("October 2026");
    expect(html).toContain("3 of 4 articles this month");
  });

  it("slotları tarih sırasıyla, tarihsizi sona koyar", () => {
    const html = render({ view: view(), projectId: "p1" });
    const first = html.indexOf("How to choose running shoes");
    const second = html.indexOf("Later article");
    const third = html.indexOf("Undated article");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("durum çipi metin taşır ve en çok 3 neden satırı gösterir", () => {
    const html = render({ view: view(), projectId: "p1" });
    expect(html).toContain("Planned");
    expect(html).toContain("Writing");
    expect(html).toContain("About 8% of your non-brand search impressions");
    expect(html).toContain("Searches for it are rising");
    expect(html).not.toContain("A fourth line that must not show");
  });

  it("Write this article bağlantısını ve More menü düğmesini çizer", () => {
    const html = render({ view: view(), projectId: "p1" });
    expect(html).toContain(PLAN_COPY.writeButton);
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain("Internal links");
    expect(html).toContain("Link to this article from");
    expect(html).toContain("The article should link to");
    expect(html).toContain("running shoe guide");
  });

  it("sürmekte olan makale için Continue writing gösterir", () => {
    const html = render({
      view: view({
        slots: [
          slot({
            canWrite: false,
            canContinue: true,
            continueHref: "/projects/p1/chat/card",
          }),
        ],
      }),
      projectId: "p1",
    });
    expect(html).toContain(PLAN_COPY.continueButton);
    expect(html).not.toContain(PLAN_COPY.writeButton);
  });

  it("compact kipte menü, açılır ve ayar yok; Open plan bağlantısı var", () => {
    const html = render({ view: view(), compact: true, projectId: "p1" });
    expect(html).not.toContain('aria-label="More actions"');
    expect(html).not.toContain("Internal links");
    expect(html).not.toContain(PLAN_COPY.limitLabel);
    expect(html).not.toContain(PLAN_COPY.refresh);
    expect(html).toContain("Open plan");
    expect(html).toContain('href="/projects/p1/arama#content-plan"');
    expect(html).toContain("How to choose running shoes");
    expect(html).toContain("Oct 14");
    expect(html).toContain(PLAN_COPY.writeButton);
  });

  it("bağlantılar doğrulanmamışsa tarama notunu gösterir", () => {
    const html = render({
      view: view({ slots: [slot({ linksVerified: false })] }),
      projectId: "p1",
    });
    expect(html).toContain(PLAN_COPY.noCrawlNote);
    const verified = render({
      view: view({ slots: [slot({ linksVerified: true })] }),
      projectId: "p1",
    });
    expect(verified).not.toContain(PLAN_COPY.noCrawlNote);
  });

  it("zayıf pillar için No strong main page yet yazar", () => {
    const html = render({
      view: view({
        pillars: [
          {
            clusterId: "c1",
            name: "Trail running",
            sharePct: 7,
            pillarPath: null,
            weak: true,
            articles: 1,
          },
        ],
      }),
      projectId: "p1",
    });
    expect(html).toContain(PLAN_COPY.noStrongMain);
    expect(html).toContain("Trail running");
    expect(html).toContain("7%");
  });

  it("alt bilgi: veri haftası sonu, söz notları ve plan notları", () => {
    const html = render({
      view: view({
        wording: "BASIC",
        notes: [PLAN_COPY.relaxedNote],
      }),
      projectId: "p1",
    });
    expect(html).toContain("Plan built from search data through Sep 27");
    expect(html).toContain(PLAN_COPY.basicWording);
    expect(html).toContain(PLAN_COPY.relaxedNote);
    const budget = render({
      view: view({ wordingNote: "budget" }),
      projectId: "p1",
    });
    expect(budget).toContain(PLAN_COPY.aiLimitNote);
  });

  it("yenileme hakkı bitince Refresh plan kapalı ve nedeni yazılı", () => {
    const html = render({
      view: view({ regenerationsLeft: 0, canRefresh: false }),
      projectId: "p1",
    });
    expect(html).toContain(PLAN_COPY.refresh);
    expect(html).toContain('disabled=""');
    expect(html).toContain("You can refresh the plan up to 3 times.");
  });

  it("boş durumlar EMPTY_COPY metnini gösterir ve Plan this month düğmesi canPlanNow'a bağlıdır", () => {
    const empty = view({
      state: "empty",
      emptyReason: "NO_GAPS",
      emptyText: EMPTY_COPY.NO_GAPS,
      slots: [],
      canPlanNow: false,
    });
    const html = render({ view: empty, projectId: "p1" });
    expect(html).toContain(EMPTY_COPY.NO_GAPS);
    expect(html).not.toContain(PLAN_COPY.planNow);
    const withButton = render({
      view: { ...empty, canPlanNow: true },
      projectId: "p1",
    });
    expect(withButton).toContain(PLAN_COPY.planNow);
  });

  it("needs_data ve waiting durumlarında liste çizilmez", () => {
    const needs = render({
      view: view({
        state: "needs_data",
        emptyText: EMPTY_COPY.NO_DATA,
        slots: [],
      }),
      projectId: "p1",
    });
    expect(needs).toContain(EMPTY_COPY.NO_DATA);
    expect(needs).not.toContain("<li");
    const waiting = render({
      view: view({ state: "waiting", slots: [], canPlanNow: true }),
      projectId: "p1",
    });
    expect(waiting).toContain("being prepared");
    expect(waiting).toContain(PLAN_COPY.planNow);
  });

  it("iç kimlikleri (kreatif, parça, kümeler) çizmez", () => {
    const html = render({ view: view(), projectId: "p1" });
    expect(html).not.toContain("creative-secret-1");
    expect(html).not.toContain("post-secret-1");
    expect(html).not.toContain("cluster-secret-1");
    const compact = render({ view: view(), compact: true, projectId: "p1" });
    expect(compact).not.toContain("creative-secret-1");
    expect(compact).not.toContain("post-secret-1");
  });

  it("atlanan slot altta, soluk ve eylemsiz listelenir", () => {
    const html = render({
      view: view({
        slots: [
          slot(),
          slot({
            id: "s9",
            title: "Skipped topic article",
            state: "SKIPPED",
            stateLabel: "Skipped",
            canSkip: false,
            canMove: false,
            canReplace: false,
            canWrite: false,
            writeHref: null,
          }),
        ],
      }),
      projectId: "p1",
    });
    expect(html.indexOf("Skipped topic article")).toBeGreaterThan(
      html.indexOf("How to choose running shoes"),
    );
    expect(html).toContain('data-skipped="true"');
    expect(html).toContain("opacity-60");
    // Atlanan satırın kendi menüsü yok: yalnız etkin slotun menüsü çizilir.
    expect(html.match(/aria-label="More actions"/g)).toHaveLength(1);
  });

  it("limit seçicisi 1..12 ve mevcut ayarla gelir", () => {
    const html = render({
      view: view({ settings: { monthlyCap: 6, autoPlan: false } }),
      projectId: "p1",
    });
    expect(html).toContain(PLAN_COPY.limitLabel);
    expect(html).toContain(PLAN_COPY.autoLabel);
    expect(html).toContain('<option value="6" selected="">6</option>');
    expect(html).toContain('<option value="12">12</option>');
  });
});
