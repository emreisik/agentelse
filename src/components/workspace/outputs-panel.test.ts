import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server actions (prisma, next-auth) never run in a static render.
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: vi.fn(),
  rejectApprovalAction: vi.fn(),
}));
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { OutputsPanel } = await import("./outputs-panel");

// The tab reads its own data client-side: the first paint is the shell with a
// skeleton, not a list baked into the project page.
describe("OutputsPanel", () => {
  it("renders the search, status strip and sort control", () => {
    const html = renderToStaticMarkup(
      createElement(OutputsPanel, { projectId: "p1", timezone: "UTC" }),
    );
    expect(html).toContain('aria-label="Search outputs"');
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain("Newest");
    expect(html).toContain("animate-pulse");
  });
});
