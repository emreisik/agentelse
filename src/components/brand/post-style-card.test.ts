import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/post-style-actions", () => ({
  addPostStyleExamplesAction: vi.fn(),
  reanalyzePostStyleExampleAction: vi.fn(),
  removePostStyleExampleAction: vi.fn(),
  setPostStyleExampleAction: vi.fn(),
  updatePostStyleDirectivesAction: vi.fn(),
}));

const { PostStyleCard } = await import("./post-style-card");

type Examples = Parameters<typeof PostStyleCard>[0]["examples"];

const render = (
  examples: Examples = [],
  directives: { text: string; fidelity: "match" | "inspired" } = {
    text: "",
    fidelity: "match",
  },
) =>
  renderToStaticMarkup(
    createElement(PostStyleCard, { projectId: "p1", examples, directives }),
  );

const read: Examples[number] = {
  assetId: "a1",
  label: "Auction ad",
  enabled: true,
  source: "upload",
  summary: "Dark premium product ad",
  recipe: "Dark card, hero phone centre.",
};

describe("PostStyleCard", () => {
  it("explains itself and invites the first examples when the kit is empty", () => {
    const html = render();
    expect(html).toContain("Post style");
    expect(html).toContain("Every post follows them");
    expect(html).toContain("0 examples");
    expect(html).toContain("No examples yet.");
    expect(html).toContain("Choose pictures");
    expect(html).toContain("Links (one per line)");
    expect(html).toContain("Add examples");
  });

  it("is honest about links: other networks do not give their pictures to apps", () => {
    expect(render()).toContain("Instagram and other networks don&#x27;t hand other accounts&#x27; pictures to apps");
  });

  it("shows each example with its picture, name, switch and how it is built", () => {
    const html = render([read]);
    expect(html).toContain("1 example");
    expect(html).toContain('src="/api/assets/a1?w=320"');
    expect(html).toContain('value="Auction ad"');
    expect(html).toContain('aria-label="Use Auction ad for new posts"');
    expect(html).toContain("Dark premium product ad");
    expect(html).toContain("How it is built");
    // The recipe is shown on request, not in the grid.
    expect(html).not.toContain("hero phone centre");
    expect(html).toContain('aria-label="Remove: Auction ad"');
  });

  it("an example that was not read can be read again", () => {
    const html = render([{ ...read, summary: null, recipe: null }]);
    expect(html).toContain("Not read yet");
    expect(html).toContain("Read again");
    expect(html).not.toContain("How it is built");
  });

  it("says where an example came from, except for a plain upload", () => {
    const html = render([
      { ...read, assetId: "l", source: "link" },
      { ...read, assetId: "c", source: "chat" },
      { ...read, assetId: "k", source: "liked" },
      { ...read, assetId: "u", source: "upload" },
    ]);
    expect(html).toContain("From a link");
    expect(html).toContain("From the chat");
    expect(html).toContain("A post you liked");
    expect(html.match(/From a link|From the chat|A post you liked/g)).toHaveLength(3);
  });

  it("an example that is switched off is dimmed", () => {
    expect(render([{ ...read, enabled: false }])).toContain("opacity-60");
    expect(render([read])).not.toContain("opacity-60");
  });

  it("the standing instructions and how closely to follow the examples", () => {
    const html = render([], { text: "Always product-focused.", fidelity: "inspired" });
    expect(html).toContain("Always apply");
    expect(html).toContain("Always product-focused.");
    expect(html).toContain("23/2000");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Use as direction/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Follow closely/);
    expect(html).toContain("take the examples as direction");
    // Nothing to save until something changes.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save/);
  });

  it("follow closely is the default and says what it means", () => {
    const html = render();
    expect(html).toMatch(/aria-pressed="true"[^>]*>Follow closely/);
    expect(html).toContain("recreate the examples&#x27; design as faithfully as possible");
  });

  it("no more can be added once the brand keeps the most", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...read, assetId: `a${i}` }));
    expect(render(twelve)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Choose pictures/);
    expect(render([read])).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Choose pictures/);
  });
});
