import { describe, expect, it } from "vitest";
import type {
  GaCheckEvidence,
  GaCheckKey,
  GaCheckStatus,
} from "@/lib/website-analytics/health/types";
import { computeFixOffers, type ComputeFixOffersInput } from "./offers";

function check(
  key: GaCheckKey,
  status: GaCheckStatus,
  evidence: GaCheckEvidence,
) {
  return { key, status, evidence };
}

function input(
  patch: Partial<ComputeFixOffersInput> = {},
): ComputeFixOffersInput {
  return {
    enabled: true,
    alphaEnabled: true,
    editGranted: true,
    checks: [],
    link: {
      keyEventNames: [],
      dataRetention: null,
      streamId: "2",
      serviceLevel: "STANDARD",
    },
    changes: [],
    ...patch,
  };
}

const MH5 = check("MH5", "WARN", { reason: "no_key_events", suggestions: [] });
const MH14 = check("MH14", "WARN", { reason: "two_months" });
const MH17 = check("MH17", "WARN", { reason: "enhanced_off" });

function kinds(offers: { kind: string }[]): string[] {
  return offers.map((offer) => offer.kind);
}

describe("computeFixOffers", () => {
  it("kapalıyken boş", () => {
    expect(computeFixOffers(input({ enabled: false, checks: [MH5] }))).toEqual(
      [],
    );
  });

  it("kontrol sırası, sonra bağımsız kanal grubu", () => {
    const offers = computeFixOffers(input({ checks: [MH17, MH5, MH14] }));
    expect(kinds(offers)).toEqual([
      "ENHANCED_MEASUREMENT",
      "KEY_EVENT_CREATE",
      "RETENTION_14M",
      "CHANNEL_GROUP_AI",
    ]);
    expect(offers[3]?.checkKey).toBeNull();
    expect(offers[0]?.checkKey).toBe("MH17");
    for (const offer of offers) {
      expect(offer.buttonLabel).toBe("Fix it for me (needs approval)");
      expect(offer.state).toBe("available");
      expect(offer.changeId).toBeNull();
    }
  });

  it("yalnız WARN/FAIL ve doğru nedenle öneri", () => {
    const none = computeFixOffers(
      input({
        checks: [
          check("MH5", "PASS", { reason: "ok" }),
          check("MH5", "UNKNOWN", { reason: "not_read" }),
          check("MH14", "PASS", { reason: "ok" }),
          check("MH14", "WARN", { reason: "error" }),
          check("MH17", "UNKNOWN", { reason: "low_volume" }),
          check("MH9", "FAIL", { reason: "x" }),
          check("MH10", "WARN", { reason: "x" }),
          check("MH7", "WARN", { reason: "x" }),
        ],
        alphaEnabled: false,
      }),
    );
    expect(none).toEqual([]);
    expect(
      kinds(
        computeFixOffers(
          input({
            checks: [
              check("MH5", "FAIL", { reason: "only_purchase" }),
              check("MH14", "FAIL", { reason: "two_months" }),
            ],
          }),
        ),
      ),
    ).toEqual(["KEY_EVENT_CREATE", "RETENTION_14M", "CHANNEL_GROUP_AI"]);
  });

  it("MH17 akış kimliği yoksa önerilmez", () => {
    const offers = computeFixOffers(
      input({
        checks: [MH17],
        link: {
          keyEventNames: [],
          dataRetention: null,
          streamId: null,
          serviceLevel: null,
        },
      }),
    );
    expect(kinds(offers)).toEqual(["CHANNEL_GROUP_AI"]);
  });

  it("seçenekler: öneriler önce, mevcutlar çıkar, en çok 6, geçersiz ad atılır", () => {
    const offers = computeFixOffers(
      input({
        checks: [
          check("MH5", "WARN", {
            reason: "no_key_events",
            suggestions: ["get_directions", "begin_checkout", "bad name", "page_view"],
          }),
        ],
        link: {
          keyEventNames: ["generate_lead", "get_directions"],
          dataRetention: null,
          streamId: "2",
          serviceLevel: null,
        },
      }),
    );
    const field = offers[0]?.field;
    expect(field?.name).toBe("eventName");
    expect(field?.options.map((option) => option.value)).toEqual([
      "begin_checkout",
      "click_to_call",
      "whatsapp_click",
      "email_click",
      "purchase",
    ]);
    const many = computeFixOffers(
      input({
        checks: [
          check("MH5", "WARN", {
            reason: "no_key_events",
            suggestions: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
          }),
        ],
      }),
    );
    expect(many[0]?.field?.options).toHaveLength(6);
  });

  it("seçenek kalmadıysa anahtar olay önerisi yok", () => {
    const offers = computeFixOffers(
      input({
        checks: [MH5],
        link: {
          keyEventNames: [
            "generate_lead",
            "click_to_call",
            "whatsapp_click",
            "email_click",
            "purchase",
          ],
          dataRetention: null,
          streamId: "2",
          serviceLevel: null,
        },
      }),
    );
    expect(kinds(offers)).toEqual(["CHANNEL_GROUP_AI"]);
  });

  it("durumlar: pending, needs_access, done", () => {
    const pending = computeFixOffers(
      input({
        checks: [MH14],
        changes: [
          {
            id: "c1",
            kind: "RETENTION_14M",
            status: "PROPOSED",
            dedupeKey: "RETENTION_14M:-",
            noop: false,
          },
        ],
      }),
    );
    expect(pending[0]).toMatchObject({ state: "pending", changeId: "c1" });

    const noAccess = computeFixOffers(
      input({ checks: [MH14], editGranted: false }),
    );
    expect(noAccess.every((offer) => offer.state === "needs_access")).toBe(true);

    const done = computeFixOffers(
      input({
        changes: [
          {
            id: "c2",
            kind: "CHANNEL_GROUP_AI",
            status: "VERIFIED",
            dedupeKey: "CHANNEL_GROUP_AI:-",
            noop: false,
          },
        ],
      }),
    );
    expect(done[0]).toMatchObject({
      kind: "CHANNEL_GROUP_AI",
      state: "done",
      changeId: "c2",
    });

    const undone = computeFixOffers(
      input({
        changes: [
          {
            id: "c3",
            kind: "CHANNEL_GROUP_AI",
            status: "UNDONE",
            dedupeKey: "CHANNEL_GROUP_AI:-",
            noop: false,
          },
        ],
      }),
    );
    expect(undone[0]?.state).toBe("available");
  });

  it("alfa kapalıyken alfa önerileri gizli", () => {
    const offers = computeFixOffers(
      input({ alphaEnabled: false, checks: [MH5, MH14, MH17] }),
    );
    expect(kinds(offers)).toEqual(["KEY_EVENT_CREATE", "RETENTION_14M"]);
  });

  it("aynı tür bir kez", () => {
    const offers = computeFixOffers(input({ checks: [MH14, MH14] }));
    expect(kinds(offers).filter((kind) => kind === "RETENTION_14M")).toHaveLength(
      1,
    );
  });

  it("kimlik ve başlıklar sayı içermez", () => {
    const offers = computeFixOffers(input({ checks: [MH5, MH14, MH17] }));
    expect(new Set(offers.map((offer) => offer.id)).size).toBe(offers.length);
    for (const offer of offers) {
      expect(offer.title).not.toMatch(/\d{3,}/);
    }
  });
});
