import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ChannelPickerView } = await import("./channel-picker");
const { ChannelSelectDone, continueMessage } = await import("./channel-select-card");
const { channelOptions } = await import("@/lib/works/work");

const OPTIONS = channelOptions({
  instagram: { connected: true, accountLabel: "@clinic" },
});

const view = (over: Partial<Parameters<typeof ChannelPickerView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ChannelPickerView, {
      title: "Which channel?",
      options: OPTIONS,
      selected: [],
      pending: false,
      error: null,
      connectHref: "/projects/p1/integrations",
      onToggle: () => undefined,
      onSubmit: () => undefined,
      ...over,
    }),
  );

describe("ChannelPickerView", () => {
  it("shows every channel with its live state", () => {
    const html = view();
    for (const label of ["Instagram", "TikTok", "LinkedIn", "Blog / SEO", "Ads"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Connected · @clinic");
    expect(html).toContain("Not connected");
    expect(html).toContain("Nothing to connect");
  });

  it("marks chosen channels as pressed", () => {
    const html = view({ selected: ["instagram"] });
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(5);
  });

  it("explains 'connect later' only when an unconnected channel is chosen", () => {
    expect(view({ selected: ["instagram"] })).not.toContain("publishing starts once");
    expect(view({ selected: ["tiktok"] })).toContain("publishing starts once");
    // SEO needs no connection, so choosing only it raises no note.
    expect(view({ selected: ["seo"] })).not.toContain("publishing starts once");
  });

  it("offers the integrations link while something is unconnected", () => {
    expect(view()).toContain('href="/projects/p1/integrations"');
  });

  it("shows the saving state and an error alert", () => {
    expect(view({ pending: true })).toContain("Saving…");
    expect(view({ error: "Pick at least one channel." })).toMatch(
      /role="alert"[^>]*>Pick at least one channel\./,
    );
  });
});

describe("kit migration (W81)", () => {
  it("keeps every pinned copy string, 44 px targets and no emerald", () => {
    const html = view({ selected: ["tiktok"] });
    expect(html).toContain("Channels for this Work");
    expect(html).toContain("Not connected yet: I&#x27;ll plan");
    expect(html).toContain("Continue");
    expect(html).toContain("Connect accounts");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("min-h-14");
    expect(html).not.toContain("min-h-10");
    expect(html).not.toContain("emerald");
    expect(html).toContain('role="group"');
    expect(html).toContain("max-w-xl");
  });

  it("blocks Continue with a visible reason while nothing is chosen", () => {
    const html = view();
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Pick at least one channel.");
  });

  it("renders the resolved receipt on the kit without emerald", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelSelectDone, {
        channels: ["instagram"],
        onChange: () => undefined,
      }),
    );
    expect(html).toContain("Channels for this Work: Instagram");
    expect(html).toContain("var(--ws-approved)");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("emerald");
  });
});

describe("resolved card", () => {
  it("collapses to one line naming the channels, with a way to change", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelSelectDone, {
        channels: ["instagram", "linkedin"],
        onChange: () => undefined,
      }),
    );
    expect(html).toContain("Instagram and LinkedIn");
    expect(html).toContain("Change");
  });

  it("resumes the stopped request in the chat", () => {
    expect(continueMessage(["instagram", "x"])).toBe("Continue with Instagram and X.");
  });
});
