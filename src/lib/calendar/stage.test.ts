import { describe, expect, it } from "vitest";

import { deriveStage, type StageInput } from "./stage";

const NOW = new Date("2026-10-03T12:00:00Z");
const HOUR = 3600 * 1000;

function input(overrides: Partial<StageInput> = {}): StageInput {
  return {
    status: "APPROVED",
    hasContent: true,
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    scheduledFor: new Date(NOW.getTime() + 24 * HOUR),
    connected: true,
    scheduleEnabled: true,
    publishTask: null,
    now: NOW,
    ...overrides,
  };
}

describe("deriveStage — yayın öncesi", () => {
  it("içeriği olmayan taslak: needs-content", () => {
    const r = deriveStage(input({ status: "DRAFT", hasContent: false }));
    expect(r.stage).toBe("needs-content");
    expect(r.movable).toBe(true);
  });

  it("içeriği olan taslak ve incelemedeki parça: needs-approval", () => {
    expect(deriveStage(input({ status: "DRAFT" })).stage).toBe(
      "needs-approval",
    );
    expect(deriveStage(input({ status: "IN_REVIEW" })).stage).toBe(
      "needs-approval",
    );
  });

  it("zamanı geçmiş onay bekleyen parça gecikmiş işaretlenir", () => {
    const r = deriveStage(
      input({
        status: "IN_REVIEW",
        scheduledFor: new Date(NOW.getTime() - 2 * HOUR),
      }),
    );
    expect(r.stage).toBe("needs-approval");
    expect(r.overdue).toBe(true);
  });

  it("reddedilen parça: rejected", () => {
    expect(deriveStage(input({ status: "REJECTED" })).stage).toBe("rejected");
  });
});

describe("deriveStage — yayın sonrası", () => {
  it("PUBLISHED: published ve taşınamaz", () => {
    const r = deriveStage(input({ status: "PUBLISHED" }));
    expect(r.stage).toBe("published");
    expect(r.movable).toBe(false);
    expect(r.overdue).toBe(false);
  });

  it("yayın görevi çalışıyorsa publishing ve taşınamaz", () => {
    const r = deriveStage(input({ publishTask: { state: "running" } }));
    expect(r.stage).toBe("publishing");
    expect(r.movable).toBe(false);
  });

  it("yayın görevi hata verdiyse failed ve nedeni taşır", () => {
    const r = deriveStage(
      input({ publishTask: { state: "failed", error: "Token expired" } }),
    );
    expect(r.stage).toBe("failed");
    expect(r.reason).toContain("Token expired");
    expect(r.movable).toBe(true);
  });
});

describe("deriveStage — hatadan sonra yeniden planlama", () => {
  const failedAt = new Date(NOW.getTime() - HOUR);

  it("hatadan sonra gelecekte yeni bir zamana taşınan parça failed değildir", () => {
    const r = deriveStage(
      input({ publishTask: { state: "failed", error: "x", at: failedAt } }),
    );
    expect(r.stage).toBe("scheduled");
  });

  it("zamanı hatadan önceyse hâlâ failed", () => {
    const r = deriveStage(
      input({
        scheduledFor: new Date(failedAt.getTime() - HOUR),
        publishTask: { state: "failed", error: "x", at: failedAt },
      }),
    );
    expect(r.stage).toBe("failed");
  });

  it("hatanın zamanı bilinmiyorsa hata gizlenmez", () => {
    const r = deriveStage(
      input({ publishTask: { state: "failed", error: "x" } }),
    );
    expect(r.stage).toBe("failed");
  });
});

describe("deriveStage — onaylı parçanın zaman ve bağlantı kuralları", () => {
  it("gelecek zamanlı, bağlı, zamanlı yayın açık: scheduled", () => {
    const r = deriveStage(input());
    expect(r.stage).toBe("scheduled");
    expect(r.reason).toBeNull();
  });

  it("zamanlı yayın kapalıysa held (kendiliğinden çıkmayacak)", () => {
    const r = deriveStage(input({ scheduleEnabled: false }));
    expect(r.stage).toBe("held");
    expect(r.reason).toMatch(/Scheduled posting is off/);
  });

  it("hesap bağlı değilse held ve hesabı adıyla söyler", () => {
    const r = deriveStage(input({ connected: false }));
    expect(r.stage).toBe("held");
    expect(r.reason).toMatch(/Instagram isn't connected/);
  });

  it("plansız eski parça (kanal yok) da bağlantı kapısına takılır", () => {
    const r = deriveStage(
      input({ channel: null, formatKey: null, connected: false }),
    );
    expect(r.stage).toBe("held");
  });

  it("zamanı olmayan onaylı parça held", () => {
    const r = deriveStage(input({ scheduledFor: null }));
    expect(r.stage).toBe("held");
    expect(r.reason).toMatch(/Pick a day/);
  });

  it("24 saatten eski, paylaşılmamış zaman: missed", () => {
    const r = deriveStage(
      input({ scheduledFor: new Date(NOW.getTime() - 30 * HOUR) }),
    );
    expect(r.stage).toBe("missed");
    expect(r.overdue).toBe(true);
  });

  it("son 24 saatte vadesi gelen ve yayın açıkken: scheduled (sırada)", () => {
    const r = deriveStage(
      input({ scheduledFor: new Date(NOW.getTime() - 2 * HOUR) }),
    );
    expect(r.stage).toBe("scheduled");
    expect(r.reason).toMatch(/Due now/);
    expect(r.overdue).toBe(false);
  });

  it("vadesi gelmiş ama zamanlı yayın kapalı: missed değil held", () => {
    const r = deriveStage(
      input({
        scheduleEnabled: false,
        scheduledFor: new Date(NOW.getTime() - 2 * HOUR),
      }),
    );
    expect(r.stage).toBe("held");
  });
});

describe("deriveStage — elle paylaşılanlar", () => {
  it("elle format (Carousel): manual", () => {
    const r = deriveStage(input({ formatKey: "instagram.carousel" }));
    expect(r.stage).toBe("manual");
  });

  it("platformsuz kanal (Blog/SEO): manual, bağlantı sormaz", () => {
    const r = deriveStage(
      input({
        platform: null,
        channel: "seo",
        formatKey: "seo.article",
        connected: false,
      }),
    );
    expect(r.stage).toBe("manual");
  });

  it("elle parçanın zamanı geçtiyse missed ve elle paylaşmayı söyler", () => {
    const r = deriveStage(
      input({
        formatKey: "instagram.carousel",
        scheduledFor: new Date(NOW.getTime() - 3 * HOUR),
      }),
    );
    expect(r.stage).toBe("missed");
    expect(r.reason).toMatch(/mark it as posted/);
  });
});
