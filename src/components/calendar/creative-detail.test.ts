import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { item } from "@/lib/calendar/test-fixtures";
import type { CalendarDetail } from "@/lib/calendar/types";

// Yazma yolları Server Action'dır (prisma, next-auth); statik render'da hiçbiri
// çalışmaz. Sheet bir portal içinde açılır: burada yalnız yerleşimi sahtelenir
// ki panelin İÇERİĞİ doğrulanabilsin.
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: vi.fn(),
  rejectApprovalAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  markCreativePublishedAction: vi.fn(),
}));
vi.mock("./detail-sheet", () => ({
  CalendarDetailSheet: (props: {
    eyebrow: ReactNode;
    title: string;
    subline: ReactNode;
    footer?: ReactNode;
    children: ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      createElement("header", null, props.eyebrow, props.title, props.subline),
      createElement("main", null, props.children),
      props.footer ? createElement("footer", null, props.footer) : null,
    ),
}));

const { CreativeDetail } = await import("./creative-detail");
const { SchedulePicker } = await import("./schedule-picker");
type DetailProps = Parameters<typeof CreativeDetail>[0];

function detail(overrides: Partial<CalendarDetail> = {}): CalendarDetail {
  return {
    caption: "Fall is here.\nShop the new menu.",
    copy: null,
    goal: "awareness",
    createdAt: "2026-10-01T09:00:00.000Z",
    version: 2,
    platform: "INSTAGRAM",
    contentFormat: "FEED_PORTRAIT",
    filename: "post.png",
    approvalId: null,
    ...overrides,
  };
}

// Tailwind sınıfları `disabled:` içerir; gerçek `disabled` özniteliğini ara.
function disabledButton(html: string, label: string): boolean {
  return new RegExp(
    `<button[^>]*\\sdisabled(?:=""|[\\s>])[^>]*>(?:<[^>]+>)*\\s*${label}`,
  ).test(html);
}

function render(overrides: Partial<DetailProps> = {}) {
  return renderToStaticMarkup(
    createElement(CreativeDetail, {
      item: item({ assetId: "a1" }),
      detail: detail(),
      projectId: "p1",
      timezone: "Europe/Istanbul",
      onSchedule: vi.fn(),
      onClose: vi.fn(),
      onDecided: vi.fn(),
      ...overrides,
    }),
  );
}

describe("CreativeDetail", () => {
  it("kimliği, durumu, zamanı ve metni kart kart gösterir", () => {
    const html = render();
    expect(html).toContain("Autumn launch");
    expect(html).toContain("Instagram · Post");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Wed, Oct 7 · 10:00");
    expect(html).toContain("Schedule");
    expect(html).toContain("Fall is here.");
    expect(html).toContain("Details");
    expect(html).toContain("v2");
    expect(html).toContain("Awareness");
  });

  it("Image Studio artık yok", () => {
    expect(render()).not.toMatch(/Image Studio|Regenerate|Edit image/i);
  });

  it("ayrıntı yüklenirken liste verisiyle anında açılır: iskelet ve önizleme", () => {
    const html = render({
      detail: undefined,
      item: item({ preview: "Fall is here." }),
    });
    // Kimlik, zaman ve zamanlama düzenleyicisi beklemeden hazır.
    expect(html).toContain("Autumn launch");
    expect(html).toContain('aria-label="Day and time"');
    // Künye iskelet, metin önizleme.
    expect(html).toContain("animate-pulse");
    expect(html).toContain("Fall is here.");
    expect(html).not.toContain("Version");
  });

  it("ayrıntı yüklenemediyse kimlik ve zamanlama yine çalışır", () => {
    const html = render({ detail: null });
    expect(html).toContain("Autumn launch");
    expect(html).toContain('aria-label="Day and time"');
    expect(html).not.toContain("animate-pulse");
  });

  it("görseli büyütülebilir olarak gösterir; görseli yoksa kart çıkarmaz", () => {
    expect(render()).toContain("/api/assets/a1");
    expect(render({ item: item({ assetId: null }) })).not.toContain(
      "/api/assets/",
    );
  });

  it("onay bekleyen parçada altta Reject ve Approve sabit durur", () => {
    const html = render({
      item: item({ stage: "needs-approval" }, { status: "IN_REVIEW" }),
      detail: detail({ approvalId: "ap1" }),
    });
    expect(html).toContain("<footer>");
    expect(html).toContain("Reject");
    expect(html).toContain("Approve");
    // Onay kaydı geldi: düğmeler etkin.
    expect(disabledButton(html, "Approve")).toBe(false);
  });

  it("onay kaydı yüklenene kadar düğmeler pasif görünür", () => {
    const html = render({
      item: item({ stage: "needs-approval" }, { status: "IN_REVIEW" }),
      detail: undefined,
    });
    expect(html).toContain("Approve");
    expect(disabledButton(html, "Approve")).toBe(true);
  });

  it("bekleyen onay kaydı yoksa karar düğmesi çıkmaz", () => {
    const html = render({
      item: item({ stage: "needs-approval" }, { status: "IN_REVIEW" }),
      detail: detail({ approvalId: null }),
    });
    expect(html).not.toContain("<footer>");
  });

  it("elle paylaşılan onaylı parçada 'Mark as posted' altta durur", () => {
    expect(render({ item: item({ stage: "manual" }) })).toContain(
      "Mark as posted",
    );
    // Zamanlanmış otomatik parçada yok.
    expect(render()).not.toContain("Mark as posted");
  });

  it("yayınlanmış parça salt okunurdur: tarih formu yok, yayın anı var", () => {
    const html = render({
      item: item(
        {
          stage: "published",
          movable: false,
          publishedAt: "2026-10-03T11:05:00.000Z",
        },
        { status: "PUBLISHED" },
      ),
    });
    expect(html).toContain("Posted Oct 3, 2026");
    expect(html).toContain("can&#x27;t be changed");
    expect(html).not.toContain('aria-label="Day and time"');
  });

  it("hata nedenini durum kartında söyler", () => {
    const html = render({
      item: item({
        stage: "failed",
        reason: "The platform said: Token expired",
      }),
    });
    expect(html).toContain("The platform said: Token expired");
  });

  it("caption ile aynı olmayan copy ayrı kart olur", () => {
    const html = render({
      detail: detail({ caption: "Short caption", copy: "Long blog copy" }),
      item: item({ assetId: null }),
    });
    expect(html).toContain("Short caption");
    expect(html).toContain("Long blog copy");
  });
});

describe("SchedulePicker", () => {
  const render = (day: string | null, time: string | null) =>
    renderToStaticMarkup(
      createElement(SchedulePicker, {
        projectId: "p1",
        creativeId: "c1",
        timezone: "Europe/Istanbul",
        day,
        time,
        onSave: vi.fn(),
      }),
    );

  it("sitenin standart seçicisini kullanır: tarihe tıklanır, yerel alan yok", () => {
    const html = render("2026-10-07", "10:00");
    expect(html).toContain('aria-label="Day and time"');
    // Alanın kendisi tarih metnidir (ikon tek başına düğme değil).
    expect(html).toContain("Wed, Oct 7 · 10:00");
    expect(html).not.toMatch(/type="(date|time|datetime-local)"/);
    expect(html).toContain("Times in Europe/Istanbul");
  });

  it("kayıtlı gün varken Remove gösterir; günü olmayanda göstermez ve Save pasif", () => {
    expect(render("2026-10-07", "10:00")).toContain("Remove");
    const empty = render(null, null);
    expect(empty).not.toContain("Remove");
    expect(empty).toContain("Pick a day and time");
    expect(disabledButton(empty, "Save")).toBe(true);
  });

  it("değişiklik yokken Save pasif (kaydedilecek bir şey yok)", () => {
    expect(disabledButton(render("2026-10-07", "10:00"), "Save")).toBe(true);
  });
});
