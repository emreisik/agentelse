import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-flow-actions", () => ({
  goToSeoStepAction: vi.fn(),
  seoBriefDefaultsAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-mode-actions", () => ({
  researchRefreshAction: vi.fn(),
  seoTargetPagesAction: vi.fn(),
  suggestSnippetAction: vi.fn(),
}));

const { pageUrlOf } = await import("./target-picker");

describe("pageUrlOf", () => {
  it("keeps a full address and adds https to a bare one", () => {
    expect(pageUrlOf("https://www.example.com/blog/x")).toBe(
      "https://www.example.com/blog/x",
    );
    expect(pageUrlOf("  example.com/blog/x ")).toBe(
      "https://example.com/blog/x",
    );
    expect(pageUrlOf("http://example.com")).toBe("http://example.com/");
  });

  it("refuses what is not a page address", () => {
    expect(pageUrlOf("")).toBeNull();
    expect(pageUrlOf("/blog/x")).toBeNull();
    expect(pageUrlOf("two words.com")).toBeNull();
    expect(pageUrlOf("ftp://example.com/x")).toBeNull();
    expect(pageUrlOf("javascript:alert(1)")).toBeNull();
    expect(pageUrlOf("localhost")).toBeNull();
  });
});
