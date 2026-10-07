import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShareRenderer } from "./renderers";

// Çizici kaydı: türe göre arama, aynı tür yeniden kaydedilince değişim.

async function load() {
  vi.resetModules();
  return import("./renderers");
}

const BRANDING = {
  displayName: "Acme",
  accent: "slate" as const,
  footer: null,
  logoAssetId: null,
};

describe("share renderer registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a kind that was never registered", async () => {
    const registry = await load();
    expect(registry.shareRendererFor("SEARCH")).toBeNull();
    expect(registry.shareRendererFor("WEBSITE")).toBeNull();
  });

  it("looks up by kind", async () => {
    const registry = await load();
    const search: ShareRenderer = async () => null;
    const website: ShareRenderer = async () => null;
    registry.registerShareRenderer("SEARCH", search);
    registry.registerShareRenderer("WEBSITE", website);
    expect(registry.shareRendererFor("SEARCH")).toBe(search);
    expect(registry.shareRendererFor("WEBSITE")).toBe(website);
  });

  it("replaces a renderer registered again for the same kind", async () => {
    const registry = await load();
    const first: ShareRenderer = async () => null;
    const second: ShareRenderer = async () => ({
      title: "t",
      periodLabel: null,
      node: null,
    });
    registry.registerShareRenderer("SEARCH", first);
    registry.registerShareRenderer("SEARCH", second);
    const found = registry.shareRendererFor("SEARCH");
    expect(found).toBe(second);
    expect(
      await found?.({ projectId: "p", reportId: "r", branding: BRANDING }),
    ).toEqual({ title: "t", periodLabel: null, node: null });
  });
});
