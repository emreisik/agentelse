import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink } from "@prisma/client";

// Gerçek React cache() yalnız React sunucu isteği içinde bellekler; testte
// istek kapsamını taklit ederiz: her testte tek bir depo (cache gibi bir kez
// üretilir), beforeEach'te sıfırlanır.
const state = vi.hoisted(() => ({ store: null as { link: unknown } | null }));
vi.mock("react", () => ({
  cache: <T>(fn: () => T) => () => {
    state.store ??= fn() as { link: unknown };
    return state.store as T;
  },
}));

const mocks = vi.hoisted(() => ({ mock: false, register: vi.fn() }));
vi.mock("@/server/seo/store", () => ({
  registerViewedGscLinkResolver: mocks.register,
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => mocks.mock,
}));

const { setViewedGscLink, viewedGscLink } = await import("./site-context");

function link(overrides: Partial<GscSiteLink> = {}): GscSiteLink {
  return {
    id: "link-2",
    projectId: "proj-1",
    isMock: false,
    isSecondary: true,
    ...overrides,
  } as GscSiteLink;
}

beforeEach(() => {
  state.store = null;
  mocks.mock = false;
});

describe("registration", () => {
  it("registers viewedGscLink as the resolver primaryGscLink consults", () => {
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledWith(viewedGscLink);
  });
});

describe("viewedGscLink", () => {
  it("returns null when nothing was set in this request", () => {
    expect(viewedGscLink("proj-1")).toBeNull();
  });

  it("returns the link set earlier in the same request scope", () => {
    const row = link();
    setViewedGscLink(row);
    expect(viewedGscLink("proj-1")).toBe(row);
  });

  it("ignores a link of another project", () => {
    setViewedGscLink(link());
    expect(viewedGscLink("proj-2")).toBeNull();
  });

  it("ignores a link of the other mode", () => {
    setViewedGscLink(link({ isMock: true }));
    expect(viewedGscLink("proj-1")).toBeNull();
    mocks.mock = true;
    expect(viewedGscLink("proj-1")).not.toBeNull();
  });

  it("can be cleared", () => {
    setViewedGscLink(link());
    setViewedGscLink(null);
    expect(viewedGscLink("proj-1")).toBeNull();
  });
});
