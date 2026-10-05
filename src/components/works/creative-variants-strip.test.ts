import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CreativeCardData } from "@/types/creative-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/creative-variant-actions", () => ({
  adoptCreativeVariantAction: vi.fn(),
}));

const { CreativeVariantsStrip } = await import("./creative-variants-strip");
const { WorkCardHostProvider } = await import("./work-card-host");

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

function card(over: Partial<ReadyCard> = {}): ReadyCard {
  return {
    kind: "creative-ready",
    title: "Post",
    creativeId: "c1",
    assetId: "a0",
    status: "IN_REVIEW",
    contentFormat: "FEED_SQUARE",
    alternatives: [{ assetId: "a1" }, { assetId: "a2" }],
    ...over,
  };
}

function render(
  c: ReadyCard,
  opts: { active?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      {
        value: {
          projectId: "p1",
          workId: "w1",
          workTitle: "Launch",
          active: opts.active ?? true,
          busy: false,
          producing: new Set<string>(),
          channels: [],
          openTab: () => undefined,
          runNextStep: () => undefined,
        },
      },
      createElement(CreativeVariantsStrip, { card: c }),
    ),
  );
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("CreativeVariantsStrip (W100 variants-ui)", () => {
  it("marks the current picture and gives one Use button per alternative", () => {
    const html = render(card());
    expect(count(html, /data-current/g)).toBe(1);
    expect(count(html, />Use this one</g)).toBe(2);
    expect(html).toContain('aria-label="Use visual 2 of 3"');
    expect(html).toContain('aria-label="Use visual 3 of 3"');
    expect(html).not.toContain('aria-label="Use visual 1 of 3"');
    for (const useButton of html.match(/<button[^>]*Use visual[^>]*>/g) ?? []) {
      expect(useButton).toContain("min-h-11");
    }
  });

  it("gives every image an alt and every thumbnail an enlarge control", () => {
    const html = render(card());
    for (const i of [1, 2, 3]) {
      expect(html).toContain(`alt="Visual ${i} of 3"`);
      expect(html).toContain(`aria-label="Enlarge visual ${i} of 3"`);
    }
    expect(html).not.toContain('alt=""');
    expect(html).toContain("/api/assets/a2");
  });

  it("shows the footnote in --ws-text-2 only while IN_REVIEW", () => {
    const html = render(card());
    expect(html).toMatch(
      /data-variants-footnote[^>]*style="color:var\(--ws-text-2\)"[^>]*>Pick before approving/,
    );
    expect(render(card({ status: "APPROVED" }))).not.toContain(
      "Pick before approving",
    );
  });

  it("has no control after approval", () => {
    const html = render(card({ status: "APPROVED" }));
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Use this one");
    expect(html).toContain("Approved, so the picture can&#x27;t change.");
  });

  it("renders nothing for an approved piece without alternatives", () => {
    expect(
      render(card({ status: "APPROVED", alternatives: undefined })),
    ).not.toContain("data-variants-strip");
  });

  it("never offers to make new pictures: nothing to pick, nothing shown", () => {
    expect(render(card({ alternatives: undefined }))).not.toContain(
      "data-variants-strip",
    );
    expect(render(card())).not.toContain("Make 3 more");
  });

  it("blocks the buttons with one visible reason when the Work is done", () => {
    const html = render(card(), { active: false });
    expect(count(html, /aria-disabled="true"/g)).toBeGreaterThanOrEqual(2);
    expect(count(html, /id="variants-reason-c1"/g)).toBe(1);
  });

  it("button budget: at most one Use per alternative", () => {
    const html = render(card());
    expect(count(html, /<button[^>]*aria-label="Use visual/g)).toBe(2);
  });
});
