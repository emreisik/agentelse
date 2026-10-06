import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F4 marka terimi önerileri): okuyucu null
// dönünce hiçbir şey çizilmez; öneriler Add / Dismiss ile listelenir; boş
// listede ipucu ve "Suggest terms" kalır; BrandTermsForm `suggestions`
// verilmeden bugünkü HTML'i aynen üretir.

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/search-analytics-actions", () => ({
  saveBrandTermsAction: vi.fn(),
}));
vi.mock("@/server/actions/search-opportunity-actions", () => ({
  suggestBrandTermsAction: vi.fn(),
  acceptBrandTermSuggestionAction: vi.fn(),
  dismissBrandTermSuggestionAction: vi.fn(),
}));
vi.mock("@/server/seo/opportunities/brand-suggest", () => ({
  readBrandTermSuggestions: mocks.read,
}));

const { BrandTermSuggestions } = await import("./brand-term-suggestions");
const { BrandTermsForm } =
  await import("@/components/search-analytics/brand-terms-form");

async function renderSuggestions(): Promise<string> {
  const element = await BrandTermSuggestions({ projectId: "proj-1" });
  return element ? renderToStaticMarkup(element) : "";
}

beforeEach(() => {
  mocks.read.mockReset();
});

describe("BrandTermSuggestions", () => {
  it("renders nothing when suggestions are off", async () => {
    mocks.read.mockResolvedValue(null);
    await expect(
      BrandTermSuggestions({ projectId: "proj-1" }),
    ).resolves.toBeNull();
    expect(mocks.read).toHaveBeenCalledWith("proj-1");
  });

  it("renders nothing when the read fails", async () => {
    mocks.read.mockRejectedValue(new Error("db down"));
    await expect(
      BrandTermSuggestions({ projectId: "proj-1" }),
    ).resolves.toBeNull();
  });

  it("lists suggested terms with Add and Dismiss", async () => {
    mocks.read.mockResolvedValue([
      { term: "acme", reason: "Your brand name", at: "2026-10-06" },
      { term: "acmee", reason: "A common misspelling", at: "2026-10-06" },
    ]);
    const html = await renderSuggestions();
    expect(html).toContain("Suggested brand terms");
    expect(html).toContain(">acme</span>");
    expect(html).toContain("A common misspelling");
    expect(html).toContain('<input type="hidden" name="term" value="acme"/>');
    expect(html).toContain('<input type="hidden" name="term" value="acmee"/>');
    expect((html.match(/>Add<\/button>/g) ?? []).length).toBe(2);
    expect((html.match(/>Dismiss<\/button>/g) ?? []).length).toBe(2);
    expect(html).toContain(">Suggest terms</button>");
    expect(html).not.toContain("We can look at your searches");
  });

  it("offers to suggest terms when there are none yet", async () => {
    mocks.read.mockResolvedValue([]);
    const html = await renderSuggestions();
    expect(html).toContain(
      "We can look at your searches and suggest spellings of your brand.",
    );
    expect(html).toContain(">Suggest terms</button>");
    expect(html).toContain(
      '<input type="hidden" name="projectId" value="proj-1"/>',
    );
    expect(html).not.toContain("Suggested brand terms");
  });
});

describe("BrandTermsForm suggestions slot", () => {
  const props = {
    projectId: "proj-1",
    terms: ["acme", "acme shop"],
    status: "ready" as const,
  };
  const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(BrandTermsForm, { ...props, ...extra }));
  // Stil sınıfları ve React'in form betiği dışında SC-F4 öncesi HTML.
  const structure = (html: string) =>
    html
      .replace(/ class="[^"]*"/g, "")
      .replace(/<script>[\s\S]*<\/script>/, "");

  it("renders the same markup as before without suggestions", () => {
    expect(structure(render())).toBe(
      '<details data-brand-terms="ready"><summary>Brand terms</summary><div><p>Searches that contain these words count as brand searches. One per line or separated by commas.</p><form action="javascript:throw new Error(&#x27;React form unexpectedly submitted.&#x27;)"><input type="hidden" name="projectId" value="proj-1"/><textarea data-slot="textarea" name="terms" rows="3" aria-label="Brand terms">acme\nacme shop</textarea><div><button type="submit" tabindex="0" data-slot="button">Save brand terms</button></div></form></div></details>',
    );
    expect(render({ suggestions: undefined })).toBe(render());
  });

  it("renders the suggestions after the form inside the details body", () => {
    const slot = createElement("div", { "data-slot-test": "x" }, "slot");
    const html = render({ suggestions: slot });
    expect(html).toContain(
      '</form><div data-slot-test="x">slot</div></div></details>',
    );
    expect(html.replace('<div data-slot-test="x">slot</div>', "")).toBe(
      render(),
    );
  });
});
