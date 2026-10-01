import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkles } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import type { CardButton } from "@/lib/works/card-action";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { ActionCard } = await import("./action-card");
const { CardActions } = await import("./card-actions");
const { PendingCard } = await import("./pending-card");
const { CardLiveRegion } = await import("./live-region");
const { SlotSuggestion } = await import("./slot-suggestion");

const count = (html: string, needle: string) => html.split(needle).length - 1;

const card = (over: Partial<Parameters<typeof ActionCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ActionCard, {
      icon: Sparkles,
      title: "Three ideas for Instagram",
      commandId: "cmd1",
      cardId: "idea-options",
      ...over,
    }),
  );

const BUTTONS: CardButton[] = [
  { id: "a", label: "Add", emphasis: "primary", action: { kind: "server", id: "a" } },
  { id: "b", label: "Plan it", emphasis: "primary", action: { kind: "send", text: "plan it" } },
  { id: "c", label: "Open", emphasis: "quiet", action: { kind: "tab", tab: "calendar" } },
  { id: "d", label: "Extra", emphasis: "secondary", action: { kind: "tab", tab: "outputs" } },
];

const actions = (over: Partial<Parameters<typeof CardActions>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CardActions, { buttons: BUTTONS, onAct: () => undefined, ...over }),
  );

describe("ActionCard (W73 kit-markup)", () => {
  it("is a group labelled by its h3 title, not a region", () => {
    const html = card();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="card-title-cmd1"');
    expect(html).toContain('<h3 id="card-title-cmd1" tabindex="-1"');
    expect(html).not.toContain("<section");
    expect(html).toContain('data-card="idea-options"');
    expect(html).toContain('data-card-id="cmd1"');
  });

  it("uses the exact WsEventCard shell classes", () => {
    const html = card();
    expect(html).toContain(
      'class="mt-1 w-full space-y-2 rounded-2xl border p-3.5 max-w-md"',
    );
    expect(html).toContain("var(--ws-surface)");
    expect(html).toContain("var(--ws-card-shadow)");
    expect(card({ width: "wide" })).toContain("max-w-xl");
    expect(card()).not.toContain("max-w-xl");
  });

  it("keeps a long title readable on two lines", () => {
    const html = card();
    expect(html).toContain("line-clamp-2");
    expect(html).not.toContain("truncate");
  });

  it("renders the status pill, reason and footnote in text-2 only", () => {
    const html = card({
      status: { label: "Pick one" },
      reason: "Why it is here",
      footnote: "A small note",
      children: createElement("p", null, "body"),
    });
    expect(html).toContain("Pick one");
    expect(html).toContain("max-[400px]:w-full");
    expect(html).toContain("Why it is here");
    expect(html).toContain("A small note");
    expect(html).toContain("var(--ws-text-2)");
    expect(html).not.toContain("color:var(--ws-text-3)");
  });

  it("muted is a dashed border without opacity on any text", () => {
    const html = card({ muted: true, reason: "Old", footnote: "Older" });
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("opacity");
    expect(card()).not.toContain("border-dashed");
  });

  it("resolved collapses to a receipt row with no children", () => {
    const html = card({
      resolved: "Instagram chosen",
      reason: "Hidden reason",
      children: createElement("p", null, "hidden body"),
    });
    expect(html).toContain("Instagram chosen");
    expect(html).toContain("var(--ws-approved)");
    expect(html).not.toContain("hidden body");
    expect(html).not.toContain("Hidden reason");
    expect(html).not.toContain("emerald");
  });
});

describe("CardActions (W73 kit-markup)", () => {
  it("is at least 44 px with a rounded-lg, at most three buttons, one primary", () => {
    const html = actions();
    expect(count(html, "min-h-11")).toBe(3);
    expect(count(html, "rounded-lg")).toBeGreaterThanOrEqual(3);
    expect(count(html, 'data-emphasis="primary"')).toBeLessThanOrEqual(1);
    expect(count(html, 'data-emphasis="primary"')).toBe(1);
    expect(count(html, "data-emphasis=")).toBeLessThanOrEqual(3);
    expect(html).toContain("flex flex-wrap items-center gap-2");
  });

  it("blocks with aria-disabled (never the native attribute) and ONE reason line", () => {
    const reason = "This Work is completed. Reopen it to continue.";
    const html = actions({
      buttons: BUTTONS.slice(0, 2).map((b) => ({ ...b, disabledReason: reason })),
    });
    expect(count(html, 'aria-disabled="true"')).toBe(2);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(count(html, reason)).toBe(1);
    const id = /id="([^"]+)" class="text-xs"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(count(html, `aria-describedby="${id}"`)).toBe(2);
    expect(html).toContain("opacity-50");
    expect(html).toContain("var(--ws-text-2)");
  });

  it("shows a passed disabledReason once for disabledAll", () => {
    const html = actions({ disabledAll: true, disabledReason: "Wait for the reply to finish." });
    expect(count(html, "Wait for the reply to finish.")).toBe(1);
    expect(count(html, 'aria-disabled="true"')).toBe(3);
  });

  it("is not blocked or described without a reason", () => {
    const html = actions();
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("aria-describedby");
  });

  it("marks the busy button aria-busy with a spinner that respects reduced motion", () => {
    const html = actions({ busyId: "a" });
    expect(count(html, 'aria-busy="true"')).toBe(1);
    expect(html).toContain("animate-spin motion-reduce:animate-none");
    expect(count(html, 'aria-disabled="true"')).toBe(3);
  });

  it("renders an error as role=alert", () => {
    const html = actions({ error: "That didn't work. Try again." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("That didn&#x27;t work. Try again.");
  });

  it("renders a same-origin link as an anchor and drops an external one", () => {
    const html = actions({
      buttons: [
        { id: "l", label: "Calendar", emphasis: "secondary", action: { kind: "link", href: "/projects/p1/calendar" } },
        { id: "x", label: "Evil", emphasis: "quiet", action: { kind: "link", href: "https://evil.example" } },
      ],
    });
    expect(html).toContain('href="/projects/p1/calendar"');
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("Evil");
  });
});

describe("small kit pieces", () => {
  it("PendingCard is a busy status with reduced-motion pulses", () => {
    const html = renderToStaticMarkup(createElement(PendingCard, { hint: "plan" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Writing three directions…");
    expect(count(html, "animate-pulse")).toBe(2);
    expect(count(html, "motion-reduce:animate-none")).toBe(2);
    expect(renderToStaticMarkup(createElement(PendingCard, { hint: "ideas" }))).toContain("Finding ideas…");
    expect(renderToStaticMarkup(createElement(PendingCard, { hint: "generic" }))).toContain("Working on it…");
  });

  it("CardLiveRegion is always rendered", () => {
    const html = renderToStaticMarkup(createElement(CardLiveRegion, { message: null }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("sr-only");
  });

  it("SlotSuggestion covers loading, empty, suggestion and zone", () => {
    const base = { label: "Fri 2 Oct, 11:00 suggested", loading: false, empty: null, hasOther: true, onOther: () => undefined, zone: "Europe/Skopje" };
    const ok = renderToStaticMarkup(createElement(SlotSuggestion, base));
    expect(ok).toContain("Fri 2 Oct, 11:00 suggested");
    expect(ok).toContain("Other time");
    expect(ok).toContain('aria-label="Show another suggested time"');
    expect(ok).toContain("min-h-11");
    expect(ok).toContain("Times in Europe/Skopje");
    const loading = renderToStaticMarkup(createElement(SlotSuggestion, { ...base, loading: true }));
    expect(loading).toContain("Finding a free day…");
    expect(loading).not.toContain("Other time");
    const empty = renderToStaticMarkup(createElement(SlotSuggestion, { ...base, empty: "No free time found." }));
    expect(empty).toContain("No free time found.");
    expect(empty).not.toContain("Other time");
    expect(renderToStaticMarkup(createElement(SlotSuggestion, { ...base, hasOther: false, zone: undefined }))).not.toContain("Times in");
  });
});
