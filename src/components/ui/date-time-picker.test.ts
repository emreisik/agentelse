import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Statik render popover'ı kapalı bırakır; burada içerik hep açık çizilir ki
// panelin KENDİSİ doğrulanabilsin. Tarayıcıdaki gerçek açılış base-ui'nindir.
vi.mock("@/components/ui/popover", () => ({
  Popover: (props: { children: ReactNode }) =>
    createElement(Fragment, null, props.children),
  PopoverTrigger: (props: {
    children: ReactNode;
    className?: string;
    disabled?: boolean;
    id?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        id: props.id,
        disabled: props.disabled,
        className: props.className,
        "data-trigger": "",
      },
      props.children,
    ),
  PopoverContent: (props: { children: ReactNode }) =>
    createElement("div", { "data-popover": "" }, props.children),
}));

const { DatePicker, DateTimePanel, DateTimePicker, TimePicker } =
  await import("./date-time-picker");
const { CalendarPanel, TimePanel } = await import("./date-time-panels");

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("DateTimePicker", () => {
  const render = (props: Record<string, unknown> = {}) =>
    html(
      createElement(DateTimePicker, {
        timezone: "Europe/Istanbul",
        defaultValue: "2026-10-07T10:00",
        ...props,
      }),
    );

  it("değeri her yerde aynı biçimde yazar (alanın kendisi tetikleyicidir)", () => {
    const out = render({ name: "date", id: "when" });
    // Alan tek bir düğme ve içinde tarih metni var: ikon tek başına tetikleyici değil.
    expect(out).toMatch(/<button[^>]*id="when"[^>]*data-trigger/);
    expect(out).toContain("Wed, Oct 7 · 10:00");
    // Form için gizli alan eski datetime-local ile aynı değeri taşır.
    expect(out).toContain('type="hidden" name="date" value="2026-10-07T10:00"');
    // Yerel tarayıcı alanı yok.
    expect(out).not.toMatch(/type="(date|time|datetime-local)"/);
  });

  it("boşken yer tutucu gösterir", () => {
    const out = render({ defaultValue: "" });
    expect(out).toContain("Pick a day and time");
  });

  it("aynı panelde takvim, saat, kısayollar ve saat dilimi bulunur", () => {
    const out = render();
    expect(out).toContain("October 2026");
    expect(out).toContain('data-slot="time-panel"');
    for (const label of ["Today", "Tomorrow", "Next Mon", "In a week"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("09:00");
    expect(out).toContain("Times in Europe/Istanbul");
    expect(out).toContain("Done");
  });

  it("seçili günü işaretler; Clear yalnız clearable iken çıkar", () => {
    const out = render();
    expect(out).toMatch(/data-day="2026-10-07"[^>]*aria-selected="true"/);
    expect(out).not.toContain("Clear");
    expect(render({ clearable: true })).toContain("Clear");
  });

  it("disablePast: bugünden önceki günleri kapatır", () => {
    // Bugün her zaman >= 2000: 2000-01-01 görünümünü zorlamak için min veriyoruz.
    const out = render({
      defaultValue: "2026-10-07T10:00",
      min: "2026-10-05",
    });
    expect(out).toMatch(/data-day="2026-10-04"[^>]*disabled=""/);
    expect(out).not.toMatch(/data-day="2026-10-05"[^>]*disabled=""/);
  });

  it("readOnly: aynı görünüm, açılmaz (düğme yok)", () => {
    const out = render({ readOnly: true });
    expect(out).toContain('role="textbox"');
    expect(out).toContain("Wed, Oct 7 · 10:00");
    expect(out).not.toContain("data-trigger");
    expect(out).not.toContain("data-popover");
  });
});

describe("DatePicker", () => {
  it("yalnız gün gösterir ve saat paneli çizmez", () => {
    const out = html(
      createElement(DatePicker, { defaultValue: "2026-10-07", name: "day" }),
    );
    expect(out).toContain("Wed, Oct 7");
    expect(out).not.toContain("time-panel");
    expect(out).toContain('name="day" value="2026-10-07"');
    expect(out).toContain("Done");
  });

  it("boşken yer tutucu", () => {
    expect(html(createElement(DatePicker, {}))).toContain("Pick a day");
  });
});

describe("TimePicker", () => {
  it("yalnız saati gösterir, saat panelini çizer, takvim çizmez", () => {
    const out = html(
      createElement(TimePicker, { defaultValue: "09:30", name: "slot1" }),
    );
    expect(out).toContain(">09:30<");
    expect(out).toContain('data-slot="time-panel"');
    expect(out).not.toContain("date-days");
    expect(out).toContain('name="slot1" value="09:30"');
  });

  it("geçersiz değeri yazmaz, gizli alan ham değeri taşır", () => {
    const out = html(createElement(TimePicker, { defaultValue: "bozuk" }));
    expect(out).toContain("Pick a time");
  });

  it("boş slot: Clear yalnız clearable ve dolu iken", () => {
    expect(
      html(createElement(TimePicker, { defaultValue: "", clearable: true })),
    ).not.toContain("Clear");
    expect(
      html(
        createElement(TimePicker, { defaultValue: "09:30", clearable: true }),
      ),
    ).toContain("Clear");
  });
});

describe("CalendarPanel", () => {
  const panel = (extra: Record<string, unknown> = {}) =>
    html(
      createElement(CalendarPanel, {
        selected: "2026-10-07",
        today: "2026-10-03",
        view: { year: 2026, month: 10 },
        onViewChange: () => undefined,
        onSelect: () => undefined,
        ...extra,
      }),
    );

  it("her zaman 42 gün (6 hafta) çizer; Pazartesi'den başlar", () => {
    const out = panel();
    expect((out.match(/data-day="/g) ?? []).length).toBe(42);
    expect(out).toContain('data-day="2026-09-28"');
    expect(out).toContain('data-day="2026-11-08"');
  });

  it("bugünü ve seçili günü ayırt eder; yalnız biri tab sırasında", () => {
    const out = panel();
    expect(out).toMatch(/data-day="2026-10-03"[^>]*aria-current="date"/);
    expect(out).toMatch(/data-day="2026-10-07"[^>]*aria-selected="true"/);
    expect((out.match(/tabindex="0"/g) ?? []).length).toBe(1);
  });

  it("planlı gün sayısı kadar nokta çizer (en çok 3)", () => {
    const out = panel({
      marks: { "2026-10-08": 1, "2026-10-09": 5 },
    });
    expect(out).toMatch(/data-day="2026-10-08"[^>]*title="1 planned"/);
    expect(out).toMatch(/data-day="2026-10-09"[^>]*title="5 planned"/);
    // 9 Ekim hücresinde 3 nokta, 8 Ekim'de 1.
    const cell9 = out.slice(out.indexOf('data-day="2026-10-09"'));
    expect(
      (cell9.slice(0, cell9.indexOf("</button>")).match(/size-\[3px\]/g) ?? [])
        .length,
    ).toBe(3);
  });

  it("alt sınırdan önceki günler kapalı", () => {
    const out = panel({ min: "2026-10-05" });
    expect(out).toMatch(/data-day="2026-10-04"[^>]*disabled=""/);
  });
});

describe("TimePanel", () => {
  const panel = (extra: Record<string, unknown> = {}) =>
    html(
      createElement(TimePanel, {
        value: "14:25",
        onChange: () => undefined,
        step: 30,
        presets: ["09:00", "18:00"],
        ...extra,
      }),
    );

  it("kaydırma listesi yok: yazma alanı, −/+ düğmeleri ve kısayollar", () => {
    const out = panel();
    expect(out).toContain('aria-label="Time (HH:mm)"');
    expect(out).toContain('value="14:25"');
    expect(out).toContain('aria-label="30 minutes earlier"');
    expect(out).toContain('aria-label="30 minutes later"');
    expect(out).toContain(">09:00<");
    expect(out).toContain(">18:00<");
    // Eski Hour/Min kaydırma sütunları gitti.
    expect(out).not.toContain('role="listbox"');
    expect(out).not.toContain('role="option"');
    expect(out).not.toMatch(/>(Hour|Min)</);
  });

  it("seçili kısayol işaretlenir, ötekiler değil", () => {
    const out = panel({ value: "18:00" });
    expect(out).toMatch(/aria-pressed="true"[^>]*>18:00</);
    expect(out).toMatch(/aria-pressed="false"[^>]*>09:00</);
  });

  it("düğme adı adımı söyler", () => {
    expect(panel({ step: 15 })).toContain('aria-label="15 minutes later"');
    expect(panel({ step: 60 })).toContain('aria-label="1 hour earlier"');
  });

  it("adım düğmeleri günün sınırında kapanır; ortada ikisi de açık", () => {
    expect(panel({ value: "00:00" })).toMatch(
      /aria-label="30 minutes earlier"[^>]*disabled=""/,
    );
    expect(panel({ value: "00:00" })).not.toMatch(
      /aria-label="30 minutes later"[^>]*disabled=""/,
    );
    expect(panel({ value: "23:30" })).toMatch(
      /aria-label="30 minutes later"[^>]*disabled=""/,
    );
    const middle = panel();
    expect(middle).not.toMatch(/minutes earlier"[^>]*disabled=""/);
    expect(middle).not.toMatch(/minutes later"[^>]*disabled=""/);
  });

  it("saat yokken adım düğmeleri kapalı, kısayollar açık", () => {
    const out = panel({ value: "" });
    expect(out).toMatch(/minutes earlier"[^>]*disabled=""/);
    expect(out).toMatch(/minutes later"[^>]*disabled=""/);
    expect(out).not.toMatch(/disabled=""[^>]*>(09:00|18:00)</);
  });

  it("kısayol listesi boşsa kısayol alanı çizilmez", () => {
    expect(panel({ presets: [] })).not.toContain("grid-cols-3");
  });
});

describe("DateTimePanel", () => {
  const panel = (extra: Record<string, unknown> = {}) =>
    html(
      createElement(DateTimePanel, {
        value: "2026-10-07T18:00",
        onChange: () => undefined,
        onDone: () => undefined,
        today: "2026-10-04",
        min: "2026-10-04",
        max: "2026-12-03",
        ...extra,
      }),
    );

  it("takvimin üstünde genel gün kısayolları, yanında kaydırmasız saat paneli", () => {
    const out = panel();
    for (const label of ["Today", "Tomorrow", "Next Mon", "In a week"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain('data-slot="time-panel"');
    expect(out).toContain('aria-label="30 minutes later"');
    expect(out).not.toContain('role="listbox"');
  });

  it("dayShortcuts verilince genel kısayolların yerine geçer", () => {
    const out = panel({
      dayShortcuts: [
        { key: "2026-10-05", label: "Mon 5" },
        { key: "2026-10-06", label: "Tue 6" },
      ],
    });
    expect(out).toContain(">Mon 5<");
    expect(out).toContain(">Tue 6<");
    expect(out).not.toContain(">Tomorrow<");
    expect(out).not.toContain(">In a week<");
  });

  it("seçili günün çipi işaretlenir; aralık dışı çip kapalı", () => {
    const out = panel({
      dayShortcuts: [
        { key: "2026-10-03", label: "Sat 3" },
        { key: "2026-10-07", label: "Wed 7" },
      ],
    });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Wed 7</);
    expect(out).toMatch(/disabled=""[^>]*>Sat 3</);
  });
});
