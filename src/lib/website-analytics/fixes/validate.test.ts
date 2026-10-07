import { describe, expect, it } from "vitest";
import { validateFixParams } from "./validate";
import type { GaFixKind } from "./types";

const ctx = { today: "2026-10-07" };

function keyEvent(eventName: unknown) {
  return validateFixParams("KEY_EVENT_CREATE", { eventName }, ctx);
}

function note(title: unknown, day: unknown = "2026-10-05") {
  return validateFixParams("ANNOTATION_CREATE", { title, day }, ctx);
}

describe("KEY_EVENT_CREATE", () => {
  it.each([
    ["generate_lead", true],
    ["a", true],
    ["A1_b2", true],
    ["a".repeat(40), true],
    ["a".repeat(41), false],
    ["1event", false],
    ["_event", false],
    ["has space", false],
    ["tire-li", false],
    ["", false],
    ["page_view", false],
    ["session_start", false],
    ["first_visit", false],
    ["user_engagement", false],
    ["google_x", false],
    ["ga_x", false],
    ["firebase_x", false],
    ["Google_x", false],
    ["gallery", true],
  ])("%s -> %s", (name, ok) => {
    expect(keyEvent(name).ok).toBe(ok);
  });

  it("kenardaki boşluk atılır", () => {
    const result = keyEvent("  generate_lead ");
    expect(result).toEqual({
      ok: true,
      params: { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" },
    });
  });

  it("sayı ya da nesne olmayan girdi geçersiz", () => {
    expect(keyEvent(12).ok).toBe(false);
    expect(validateFixParams("KEY_EVENT_CREATE", "x", ctx).ok).toBe(false);
    expect(validateFixParams("KEY_EVENT_CREATE", null, ctx).ok).toBe(false);
    expect(validateFixParams("KEY_EVENT_CREATE", [], ctx).ok).toBe(false);
  });
});

describe("ANNOTATION_CREATE", () => {
  it("öneki ekler", () => {
    expect(note("Spring sale")).toEqual({
      ok: true,
      params: {
        kind: "ANNOTATION_CREATE",
        title: "Agentelse: Spring sale",
        day: "2026-10-05",
      },
    });
  });

  it("önek tekrarlanmaz", () => {
    const once = note("Agentelse: Spring sale");
    const twice = note("Agentelse: Agentelse: Spring sale");
    expect(once.ok && once.params).toMatchObject({
      title: "Agentelse: Spring sale",
    });
    expect(twice.ok && twice.params).toMatchObject({
      title: "Agentelse: Agentelse: Spring sale",
    });
  });

  it("URL, açılı parantez ve kontrol karakterlerini atar", () => {
    const result = note("Sale <b>now</b>\u0000\u0007 https://evil.example/x www.a.com ok");
    expect(result.ok && result.params).toMatchObject({
      title: "Agentelse: Sale b now /b ok",
    });
  });

  it("toplam uzunluk 60'ı geçmez (çok baytlı metin dahil)", () => {
    const long = note("ş".repeat(100));
    expect(long.ok).toBe(true);
    if (long.ok && long.params.kind === "ANNOTATION_CREATE") {
      expect(Array.from(long.params.title).length).toBe(60);
    }
    const emoji = note("😀".repeat(100));
    if (emoji.ok && emoji.params.kind === "ANNOTATION_CREATE") {
      expect(Array.from(emoji.params.title).length).toBeLessThanOrEqual(60);
      expect(emoji.params.title).not.toMatch(/�/);
    } else {
      throw new Error("beklenmeyen ret");
    }
  });

  it("boş konu geçersiz", () => {
    expect(note("   ").ok).toBe(false);
    expect(note("https://x.example/a").ok).toBe(false);
    expect(note("Agentelse:").ok).toBe(false);
    expect(note(5).ok).toBe(false);
  });

  it("tarih penceresi bugün-30 ile bugün+1 arası", () => {
    expect(note("x", "2026-10-07").ok).toBe(true);
    expect(note("x", "2026-10-08").ok).toBe(true);
    expect(note("x", "2026-10-09").ok).toBe(false);
    expect(note("x", "2026-09-07").ok).toBe(true);
    expect(note("x", "2026-09-06").ok).toBe(false);
  });

  it("gerçek olmayan tarih geçersiz", () => {
    expect(note("x", "2026-02-30").ok).toBe(false);
    expect(note("x", "2026-13-01").ok).toBe(false);
    expect(note("x", "07/10/2026").ok).toBe(false);
    expect(
      validateFixParams("ANNOTATION_CREATE", { title: "x" }, ctx).ok,
    ).toBe(false);
  });

  it("nesne olmayan girdi geçersiz", () => {
    expect(validateFixParams("ANNOTATION_CREATE", "x", ctx).ok).toBe(false);
    expect(validateFixParams("ANNOTATION_CREATE", undefined, ctx).ok).toBe(
      false,
    );
  });
});

describe("alansız türler ve bilinmeyen tür", () => {
  it.each(["RETENTION_14M", "ENHANCED_MEASUREMENT", "CHANNEL_GROUP_AI"] as const)(
    "%s girdiyi yok sayar",
    (kind) => {
      expect(validateFixParams(kind, undefined, ctx)).toEqual({
        ok: true,
        params: { kind },
      });
    },
  );

  it("bilinmeyen tür geçersiz", () => {
    const result = validateFixParams("NOPE" as GaFixKind, {}, ctx);
    expect(result.ok).toBe(false);
  });
});
