import { describe, expect, it } from "vitest";

import { changeFixture } from "@/lib/seo/apply/test-support";

import { changeViewOf } from "./store";

// Bu dosyanın kanıtladığı: changeViewOf PROPOSED satırın durum etiketini
// Approval satırından türetir (sohbette verilen ret hemen "Rejected"), canDecide
// yalnız yönetici + bekleyen onayda açılır, canUndo/canMakeLive yaşam döngüsü
// kurallarını izler ve hata metni her zaman sabit metindir.

const NOW = new Date("2026-10-07T10:00:00.000Z");
const EXTRA = { approvalStatus: "PENDING", viewerIsManager: true, hasOpenLive: false };

describe("changeViewOf", () => {
  it("a pending proposal is decidable by a manager only", () => {
    const view = changeViewOf(changeFixture(), EXTRA, NOW);
    expect(view.statusLabel).toBe("Waiting for approval");
    expect(view.canDecide).toBe(true);
    expect(view.expiresAt).not.toBeNull();
    expect(
      changeViewOf(changeFixture(), { ...EXTRA, viewerIsManager: false }, NOW)
        .canDecide,
    ).toBe(false);
  });

  it("derives Rejected and Expired from the approval row for a PROPOSED change", () => {
    expect(
      changeViewOf(changeFixture(), { ...EXTRA, approvalStatus: "REJECTED" }, NOW)
        .statusLabel,
    ).toBe("Rejected");
    const expired = changeViewOf(
      changeFixture(),
      { ...EXTRA, approvalStatus: "CANCELLED" },
      NOW,
    );
    expect(expired.statusLabel).toBe("Expired");
    expect(expired.canDecide).toBe(false);
  });

  it("a verified article can be made live until a PUBLISH_LIVE is open, and shows as a draft", () => {
    const row = changeFixture({
      kind: "PUBLISH_ARTICLE",
      status: "VERIFIED",
      appliedAt: new Date(NOW.getTime() - 3_600_000),
      verifiedAt: NOW,
      params: {
        kind: "PUBLISH_ARTICLE",
        creativeId: "cr-1",
        versionId: "v-1",
        title: "T",
        metaDescription: "",
        markdown: "x",
        language: null,
      },
      after: { exists: true, status: "draft" },
    });
    const view = changeViewOf(row, EXTRA, NOW);
    expect(view.canMakeLive).toBe(true);
    expect(view.canUndo).toBe(true);
    expect(view.undoWarning).toBe("Undo moves the draft to the WordPress Trash.");
    expect(view.draft).toBe(true);
    expect(changeViewOf(row, { ...EXTRA, hasOpenLive: true }, NOW).canMakeLive).toBe(
      false,
    );
  });

  it("an article that is already public cannot be made live again", () => {
    const row = changeFixture({
      kind: "PUBLISH_ARTICLE",
      status: "VERIFIED",
      appliedAt: new Date(NOW.getTime() - 3_600_000),
      verifiedAt: NOW,
      after: { exists: true, status: "publish" },
    });
    const view = changeViewOf(row, EXTRA, NOW);
    expect(view.canMakeLive).toBe(false);
    expect(view.draft).toBe(false);
  });

  it("a noop change can be neither undone nor made live", () => {
    const view = changeViewOf(
      changeFixture({
        kind: "PUBLISH_ARTICLE",
        status: "VERIFIED",
        noop: true,
        appliedAt: NOW,
      }),
      EXTRA,
      NOW,
    );
    expect(view.canUndo).toBe(false);
    expect(view.canMakeLive).toBe(false);
  });

  it("a written FAILED row is undoable and shows the fixed error text", () => {
    const view = changeViewOf(
      changeFixture({
        status: "FAILED",
        appliedAt: NOW,
        failedAt: NOW,
        error: { code: "readback_mismatch", message: "" },
      }),
      EXTRA,
      NOW,
    );
    expect(view.canUndo).toBe(true);
    expect(view.error?.code).toBe("readback_mismatch");
    expect(view.error?.message).toMatch(/showed something different/);
  });

  it("ignores an error blob with an unknown code", () => {
    const view = changeViewOf(
      changeFixture({ status: "FAILED", error: { code: "weird", message: "raw" } }),
      EXTRA,
      NOW,
    );
    expect(view.error).toBeNull();
  });

  it("takes the link from liveUrl first and reads the IndexNow state", () => {
    const view = changeViewOf(
      changeFixture({
        status: "VERIFIED",
        targetUrl: "https://example.com/a",
        liveUrl: "https://example.com/b",
        indexNow: { state: "SENT", at: NOW.toISOString(), urls: 1 },
      }),
      EXTRA,
      NOW,
    );
    expect(view.link).toBe("https://example.com/b");
    expect(view.indexNow).toBe("SENT");
  });

  it("builds an approver preview from the stored params without the expiry row once decided", () => {
    const proposed = changeViewOf(changeFixture(), EXTRA, NOW);
    expect(proposed.preview.map((row) => row.label)).toContain("Expires");
    const done = changeViewOf(changeFixture({ status: "VERIFIED" }), EXTRA, NOW);
    expect(done.preview.map((row) => row.label)).not.toContain("Expires");
    expect(done.preview.find((row) => row.label === "After")?.value).toBe(
      "Pricing for small teams",
    );
  });
});
