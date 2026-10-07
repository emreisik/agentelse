import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ApplyOffer } from "@/lib/seo/apply/view-types";

// Bu dosyanın kanıtladığı ("Apply with approval" düğmesi): TITLE_META teklifi
// ne değişeceğini ve "You approve it in the next step" notunu gösterir;
// INTERNAL_LINKS kaynak sayfaya göre gruplanır, her düğme en çok 3 bağlantı
// taşır; bekleyen ve uygulanmış durumlar değişikliğe bağlanır; SnippetApplyPanel
// applyReady olmadan hiçbir şey çizmez.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  proposeApplyAction: vi.fn(),
}));

const { ApplyWithApprovalButton, SnippetApplyPanel, groupLinksByPage } =
  await import("./apply-with-approval-button");

function offer(overrides: Partial<ApplyOffer> = {}): ApplyOffer {
  return {
    state: "ready",
    changeId: null,
    actionId: "act1",
    findingId: null,
    kind: "TITLE_META",
    links: [],
    hint: null,
    ...overrides,
  };
}

function html(props: {
  offer: ApplyOffer;
  defaultText?: { title: string | null; metaDescription: string | null };
  isManager?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ApplyWithApprovalButton, { projectId: "project-1", ...props }),
  );
}

function links(from: string, count: number): ApplyOffer["links"] {
  return Array.from({ length: count }, (_, index) => ({
    fromUrl: from,
    toUrl: `https://example.com/target-${index}`,
    anchor: `anchor ${index}`,
  }));
}

describe("ApplyWithApprovalButton", () => {
  it("shows what changes for a title/description offer and the approval note", () => {
    const markup = html({
      offer: offer(),
      defaultText: { title: "A better title", metaDescription: "A better description" },
      isManager: true,
    });
    expect(markup).toContain("Apply with approval");
    expect(markup).toContain("A better title");
    expect(markup).toContain("A better description");
    expect(markup).toContain("You approve it in the next step.");
  });

  it("tells a non-manager that an owner or admin approves", () => {
    const markup = html({ offer: offer(), isManager: false });
    expect(markup).toContain("An owner or admin approves it in the next step.");
  });

  it("groups internal links by source page, three per button", () => {
    const groups = groupLinksByPage([
      ...links("https://example.com/a", 4),
      ...links("https://example.com/b", 1),
    ]);
    expect(groups.map((group) => group.fromUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(groups[0]!.chunks.map((chunk) => chunk.length)).toEqual([3, 1]);
    expect(groups[1]!.chunks.map((chunk) => chunk.length)).toEqual([1]);

    const markup = html({
      offer: offer({
        kind: "INTERNAL_LINKS",
        links: [...links("https://example.com/a", 4), ...links("https://example.com/b", 1)],
      }),
    });
    // 3 dilim = 3 düğme (a: 3 + 1, b: 1).
    expect(markup.match(/Apply with approval/g)).toHaveLength(3);
    expect(markup).toContain("/a");
    expect(markup).toContain("/b");
    expect(markup).toContain("“anchor 0” → /target-0");
  });

  it("shows one button when an internal-links finding has no action yet", () => {
    const markup = html({
      offer: offer({ kind: "INTERNAL_LINKS", actionId: null, findingId: "f1" }),
    });
    expect(markup.match(/Apply with approval/g)).toHaveLength(1);
    expect(markup).toContain("Adds internal links");
  });

  it("links a pending or applied offer to the change and shows no button", () => {
    const pending = html({ offer: offer({ state: "pending", changeId: "chg_1" }) });
    expect(pending).toContain("Waiting for approval");
    expect(pending).toContain("/projects/project-1/arama#change-chg_1");
    expect(pending).not.toContain("Apply with approval");

    const applied = html({ offer: offer({ state: "applied", changeId: "chg_2" }) });
    expect(applied).toContain("Applied on your site");
    expect(applied).toContain("#change-chg_2");
    expect(applied).not.toContain("Apply with approval");
  });

  it("shows only the hint for blocked and needs-text offers", () => {
    const blocked = html({ offer: offer({ state: "blocked", hint: "Not available here." }) });
    expect(blocked).toContain("Not available here.");
    expect(blocked).not.toContain("Apply with approval");
    expect(html({ offer: offer({ state: "needs_text" }) })).toBe("");
  });
});

describe("SnippetApplyPanel", () => {
  function panel(applyReady: boolean, title: string | null = "T", meta: string | null = "D"): string {
    return renderToStaticMarkup(
      createElement(SnippetApplyPanel, {
        projectId: "project-1",
        actionId: "act1",
        title,
        metaDescription: meta,
        applyReady,
      }),
    );
  }

  it("renders nothing unless the server says apply is ready", () => {
    expect(panel(false)).toBe("");
  });

  it("renders nothing without any text", () => {
    expect(panel(true, null, null)).toBe("");
  });

  it("renders the apply button with the chosen text", () => {
    const markup = panel(true, "Chosen title", "Chosen description");
    expect(markup).toContain("Apply with approval");
    expect(markup).toContain("Chosen title");
    expect(markup).toContain("Chosen description");
  });
});
