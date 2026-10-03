import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/creative-rating-actions", () => ({
  rateCreativeAction: vi.fn(),
  addLikedCreativeToPostStyleAction: vi.fn(),
}));

const { CREATIVE_RATING_COPY, CreativeRating } = await import(
  "./creative-rating"
);

describe("CreativeRating", () => {
  const html = renderToStaticMarkup(
    createElement(CreativeRating, { creativeId: "cr-1" }),
  );

  it("starts as two quiet icon buttons with names a screen reader can read", () => {
    expect(html).toContain("data-creative-rating");
    expect(html).toContain(`aria-label="${CREATIVE_RATING_COPY.like}"`);
    expect(html).toContain(`aria-label="${CREATIVE_RATING_COPY.dislike}"`);
    expect(html).toContain(CREATIVE_RATING_COPY.hint);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("does not ask what was wrong until the client says it was not quite right", () => {
    expect(html).not.toContain(CREATIVE_RATING_COPY.whatWasWrong);
    expect(html).not.toContain("<input");
  });

  it("keeps every sentence in its copy table, clean of edge spaces", () => {
    for (const [key, value] of Object.entries(CREATIVE_RATING_COPY)) {
      expect(value, key).not.toBe("");
      expect(value, key).toBe(value.trim());
    }
  });
});
