import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  getManualPublishItemsAction: vi.fn(),
  markCreativePublishedAction: vi.fn(),
}));

const { ManualPublishList } = await import("./manual-publish-dialog");

const item = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  title: "Clinic guide",
  where: "Blog / SEO · Article",
  date: "2026-10-05",
  text: "Full article text",
  assetId: undefined,
  ...over,
});

const render = (props: Partial<Parameters<typeof ManualPublishList>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ManualPublishList, {
      items: [item()],
      onCopy: vi.fn(),
      onPublished: vi.fn(),
      ...props,
    }),
  );

describe("ManualPublishList", () => {
  it("shows what to post, where it goes and when", () => {
    const html = render();
    expect(html).toContain("Clinic guide");
    expect(html).toContain("Blog / SEO · Article · 2026-10-05");
    expect(html).toContain("Full article text");
    expect(html).toContain("Copy text");
    expect(html).toContain("I posted it myself");
  });

  it("offers the image as a download when the piece has one", () => {
    const html = render({ items: [item({ assetId: "asset-1" })] });
    expect(html).toContain('href="/api/assets/asset-1"');
    expect(html).toContain("download");
    expect(html).toContain("Download image");
    // No image: no download link.
    expect(render()).not.toContain("Download image");
  });

  it("does not offer to copy text a piece does not have", () => {
    const html = render({ items: [item({ text: "" })] });
    expect(html).not.toContain("Copy text");
    expect(html).toContain("I posted it myself");
  });

  it("an unscheduled piece shows no date", () => {
    expect(render({ items: [item({ date: "" })] })).toContain(
      "Blog / SEO · Article</p>",
    );
  });

  it("waits on every button while one piece is being marked", () => {
    const html = render({
      items: [item(), item({ id: "c2", title: "Second" })],
      busyId: "c1",
    });
    const disabled = html.match(/<button[^>]*\sdisabled(=""|\s|>)/g) ?? [];
    expect(disabled).toHaveLength(2);
  });

  it("says so when nothing is left", () => {
    expect(render({ items: [] })).toContain("Nothing is waiting for you to post.");
  });
});
