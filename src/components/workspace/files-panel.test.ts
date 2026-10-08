import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/actions/library-actions", () => ({
  uploadLibraryAssetAction: vi.fn(),
}));

const { FilesPanel, IMAGE_PREVIEW_LIMIT } = await import("./files-panel");

import type { LibraryAsset } from "@/components/hub-core/panels/library-browser";

const asset = (id: string, filename: string, mimeType: string): LibraryAsset => ({
  id,
  filename,
  mimeType,
  size: 1,
  createdAt: "2026-10-03T00:00:00.000Z",
  type: "IMAGE",
});

const render = (assets: LibraryAsset[]) =>
  renderToStaticMarkup(createElement(FilesPanel, { projectId: "proj-1", assets }));

// What this suite proves: images are shown as thumbnails (the file itself),
// not as a generic icon row; documents stay a list; a long image list is cut
// with a "Show all".
describe("FilesPanel", () => {
  it("lists the brand's own photos in a Photos group of their own", () => {
    const html = render([
      { ...asset("ph1", "terrace.jpg", "image/jpeg"), photo: true },
      asset("img1", "post.jpg", "image/jpeg"),
    ]);
    expect(html).toContain("Photos");
    const photos = html.indexOf("Photos");
    expect(html.indexOf('data-file-thumb="ph1"')).toBeGreaterThan(photos);
    expect(html.indexOf('data-file-thumb="img1"')).toBeGreaterThan(
      html.indexOf('data-file-thumb="ph1"'),
    );
  });

  it("shows images and logos as thumbnails and documents as a list", () => {
    const html = render([
      asset("logo1", "brand-logo.png", "image/png"),
      asset("img1", "post.jpg", "image/jpeg"),
      asset("doc1", "brand-guide.pdf", "application/pdf"),
    ]);
    expect(html).toContain('data-file-thumb="logo1"');
    expect(html).toContain('data-file-thumb="img1"');
    expect(html).toContain('src="/api/assets/img1?w=320"');
    // A PDF named "brand" is a document, not a logo thumbnail.
    expect(html).not.toContain('data-file-thumb="doc1"');
    expect(html).toContain("brand-guide.pdf");
    expect(html).toContain('aria-label="Download brand-guide.pdf"');
  });

  it("cuts a long image list and offers to show all", () => {
    const many = Array.from({ length: IMAGE_PREVIEW_LIMIT + 3 }, (_, i) =>
      asset(`i${i}`, `post-${i}.png`, "image/png"),
    );
    const html = render(many);
    expect(html.match(/data-file-thumb=/g)).toHaveLength(IMAGE_PREVIEW_LIMIT);
    expect(html).toContain(`Show all ${IMAGE_PREVIEW_LIMIT + 3}`);
  });
});
