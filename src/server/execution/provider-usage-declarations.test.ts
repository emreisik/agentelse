import { describe, expect, it, vi } from "vitest";

import type { CapabilityKey } from "@prisma/client";

// Every provider that spends the customer's plan allowance has to say so. A
// provider without a `usageEstimate` is treated as free of charge, so a NEW paid
// provider that forgets to declare one would silently give its work away. The
// provider "type" tells the two apart: "AI" providers call a paid model; "API"
// providers publish or write to a platform and cost nothing in AI spend.

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");

const { ProviderRegistry } = await import("./provider-registry");
const { usageNeedOf } = await import("./usage-need");

const real = ProviderRegistry.registered().filter(
  (provider) => !provider.key.startsWith("mock-"),
);

function declare(
  key: "openai-creative" | "openai-ai",
  capability: CapabilityKey,
  payload: unknown,
) {
  const provider = real.find((candidate) => candidate.key === key)!;
  return provider.usageEstimate!({
    executionJobId: "j",
    correlationId: "c",
    idempotencyKey: "k",
    capability,
    context: {
      workspaceId: "w",
      projectId: "p",
      brandId: "b",
      taskId: "t",
      capability,
      riskLevel: "LOW",
    },
    payload,
  });
}

describe("provider usage declarations", () => {
  it("sees the providers it is supposed to police", () => {
    expect(real.map((provider) => provider.key)).toEqual(
      expect.arrayContaining(["openai-ai", "openai-creative"]),
    );
  });

  it.each(real.map((provider) => [provider.key, provider] as const))(
    "%s: a paid (AI) provider declares what it spends, a platform one does not",
    (_key, provider) => {
      if (provider.type === "AI") {
        expect(provider.usageEstimate).toBeTypeOf("function");
      } else {
        expect(provider.usageEstimate).toBeUndefined();
      }
    },
  );

  // The resume step sizes a parked job from its capability and payload alone
  // (usageNeedOf); startExecution reserves what the provider declares. They must
  // agree, or a resumed job reserves one amount and runs against another.
  it.each([
    ["CREATE_SOCIAL_CREATIVE", { request: "x" }],
    ["CREATE_SOCIAL_CREATIVE", { variantCount: 3 }],
    ["CREATE_SOCIAL_CREATIVE", { adaptFromAssetId: "a" }],
    ["CREATE_SOCIAL_CREATIVE", { photoAssetIds: ["a"] }],
    ["CREATE_AD_CREATIVE", { request: "x" }],
  ] as const)("picture job %s %j is sized the same by both", (capability, payload) => {
    const declared = declare("openai-creative", capability, payload);
    expect(declared.class).toBe("content");
    const need = usageNeedOf(capability, payload);
    if (declared.class === "content" && declared.images > 0) {
      expect(need).toEqual({ unit: "IMAGE", amount: BigInt(declared.images) });
    } else {
      expect(need).toBeNull();
    }
  });

  it.each([
    ["CREATE_COPY", { request: "write something" }],
    ["MARKET_RESEARCH", { request: "x".repeat(2_000) }],
    ["WEB_RESEARCH", { request: "x" }],
  ] as const)("text job %s %j is sized the same by both", (capability, payload) => {
    const declared = declare("openai-ai", capability, payload);
    expect(declared.class).toBe("ai");
    const need = usageNeedOf(capability, payload);
    expect(need?.unit).toBe("AI_MICROS");
    if (declared.class === "ai") {
      expect(need!.amount).toBe(
        BigInt(Math.round(declared.maxCostUsd * 1_000_000)),
      );
    }
  });

  it("a capability no paid provider owns is free of charge", () => {
    expect(usageNeedOf("INSTAGRAM_PUBLISH", { creativeId: "c" })).toBeNull();
    expect(usageNeedOf("META_CAMPAIGN_CREATE", {})).toBeNull();
  });
});
