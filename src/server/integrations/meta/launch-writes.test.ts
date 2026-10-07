import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./graph", () => ({ metaFetch: vi.fn() }));

import { objectStorySpec } from "./launch-writes";

const common = {
  pageId: "9",
  imageHash: "h0",
  message: "Spring sale",
  link: "https://example.com",
  callToAction: "LEARN_MORE",
};

describe("objectStorySpec", () => {
  it("builds the single image ad as before", () => {
    expect(objectStorySpec(common)).toEqual({
      page_id: "9",
      link_data: {
        image_hash: "h0",
        link: "https://example.com",
        message: "Spring sale",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
      },
    });
  });

  it("builds a carousel in the shape the old wizard proved on live accounts", () => {
    const spec = objectStorySpec({
      ...common,
      instagramUserId: "ig1",
      cards: [
        { imageHash: "h1", link: "https://example.com/a", headline: "A" },
        { imageHash: "h2", link: "https://example.com/b", description: "B desc" },
      ],
    });
    expect(spec).toEqual({
      page_id: "9",
      instagram_user_id: "ig1",
      link_data: {
        link: "https://example.com/a",
        message: "Spring sale",
        child_attachments: [
          { link: "https://example.com/a", image_hash: "h1", name: "A" },
          { link: "https://example.com/b", image_hash: "h2", description: "B desc" },
        ],
        call_to_action: { type: "LEARN_MORE" },
      },
    });
  });

  it("falls back to the single picture when fewer than two cards are given", () => {
    const spec = objectStorySpec({ ...common, cards: [{ imageHash: "h1", link: "https://example.com" }] });
    expect(JSON.stringify(spec)).not.toContain("child_attachments");
  });
});
