import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { photoTopicOf } = await import("./photo-post");

describe("photoTopicOf", () => {
  it("uses the first sentence of what the photo shows", () => {
    const { topic, captionIdea } = photoTopicOf({
      description: "A sunlit brunch table on a terrace. Two cups of coffee.",
      tags: ["brunch"],
    });
    expect(topic).toBe("A sunlit brunch table on a terrace.");
    expect(captionIdea).toContain("Two cups of coffee.");
  });

  it("falls back to the tags, then to a plain title", () => {
    expect(photoTopicOf({ description: null, tags: ["terrace", "brunch"] }).topic).toBe(
      "terrace, brunch",
    );
    expect(photoTopicOf({ description: "", tags: [] }).topic).toBe(
      "Post from your photo",
    );
  });

  it("keeps the topic short", () => {
    const long = "word ".repeat(60);
    expect(photoTopicOf({ description: long, tags: [] }).topic.length).toBeLessThanOrEqual(80);
  });
});
