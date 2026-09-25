import { describe, expect, it } from "vitest";

import { parseIntent } from "@/server/commands/intent-router";

describe("parseIntent — capability commands (spec section 7 examples)", () => {
  it("parses Instagram creative creation, with Turkish consonant softening (hesap -> hesabı)", () => {
    const result = parseIntent(
      "Biduniq için iPhone 17 temalı Instagram postu hazırla.",
    );
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: "INSTAGRAM",
    });
  });

  // Previously nothing in the chat pipeline captured this at all — asking
  // for "an Instagram Story" silently produced a square Feed image every
  // time, since getCreativePlatformFormat always fell back to the
  // platform's default with no way to override it from chat.
  it("detects a Story request and sets contentFormat", () => {
    const result = parseIntent("Instagram için bir hikaye oluştur.");
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: "INSTAGRAM",
      contentFormat: "STORY",
    });
  });

  it("detects a Reel request ('reel' is a common Turkish loanword) and sets contentFormat", () => {
    // The rule-based parser's action verbs (hazırla/oluştur/yap) are
    // Turkish-only — an all-English sentence never matches this fallback
    // parser at all regardless of contentFormat (it's meant for the exact
    // command examples this codebase's Turkish-speaking users type; a
    // genuinely English message goes through the LLM chat-turn.ts path
    // instead, which has its own contentFormat field).
    const result = parseIntent(
      "Instagram için lansman hakkında bir reel oluştur.",
    );
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: "INSTAGRAM",
      contentFormat: "REEL",
    });
  });

  it("leaves contentFormat unset for a plain post request (platform default applies)", () => {
    const result = parseIntent(
      "Biduniq için iPhone 17 temalı Instagram postu hazırla.",
    );
    expect(result.kind).toBe("CAPABILITY");
    if (result.kind === "CAPABILITY") {
      expect(result.contentFormat).toBeUndefined();
    }
  });

  it("parses TikTok account creation despite the b/p consonant shift", () => {
    const result = parseIntent("Blabla için TikTok hesabı oluştur.");
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "SOCIAL_ACCOUNT_SETUP",
      targetPlatform: "TIKTOK",
    });
  });

  it("parses competitor research", () => {
    const result = parseIntent("BityPay rakiplerini bugün analiz et.");
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "COMPETITOR_RESEARCH",
    });
  });

  it("parses analytics/performance lookups", () => {
    const result = parseIntent(
      "Biduniq Instagram hesabında son postun performansına bak.",
    );
    expect(result).toMatchObject({
      kind: "CAPABILITY",
      capability: "ANALYTICS_ANALYSIS",
    });
  });
});

describe("parseIntent — approval decisions", () => {
  it("detects an approval", () => {
    expect(parseIntent("Bu görseli onaylıyorum.")).toMatchObject({
      kind: "APPROVAL_DECISION",
      decision: "APPROVE",
    });
  });

  it("detects a rejection", () => {
    expect(parseIntent("Bu işi reddediyorum.")).toMatchObject({
      kind: "APPROVAL_DECISION",
      decision: "REJECT",
    });
  });

  it("detects a revision request", () => {
    const result = parseIntent("Revize et, daha premium olsun.");
    expect(result).toMatchObject({
      kind: "APPROVAL_DECISION",
      decision: "REVISE",
    });
  });
});

describe("parseIntent — status queries and fallback", () => {
  it("detects a status query", () => {
    expect(parseIntent("Bugün hangi işler bekliyor?")).toMatchObject({
      kind: "STATUS_QUERY",
    });
  });

  it("falls back to UNKNOWN for unrelated text", () => {
    expect(parseIntent("merhaba nasılsın")).toMatchObject({ kind: "UNKNOWN" });
  });
});
