import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PlanOptionsCardData } from "@/lib/works/plan-options";
import type { WorkCardHostInput } from "./work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/plan-options-actions", () => ({
  pickPlanOptionAction: vi.fn(),
}));

const { PlanOptionsCard, mapPickResult, shouldCancelFocus } = await import("./plan-options-card");
const { WorkCardHostProvider } = await import("./work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "Week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [
    { key: "instagram", label: "Instagram", connected: true },
    { key: "linkedin", label: "LinkedIn", connected: true },
  ],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const CARD: PlanOptionsCardData = {
  kind: "content-plan-options",
  title: "Launch week",
  reason: "Three ways to open the week.",
  timezone: "Europe/Istanbul",
  state: "open",
  brandCheck: { state: "checked", rules: 4 },
  slots: [
    {
      date: "2026-10-05",
      time: "10:00",
      channel: "instagram",
      formatKey: "instagram.post",
    },
    {
      date: "2026-10-07",
      time: "10:00",
      channel: "linkedin",
      formatKey: "linkedin.post",
    },
  ],
  options: [
    {
      id: "a",
      label: "Education first",
      angle: "Teach the one thing clients ask about most.",
      basis: "Top question: pricing",
      ideas: [
        {
          topic: "Pricing explained",
          captionIdea: "What a plan costs and why.",
        },
        { topic: "Three myths", captionIdea: "Myths about onboarding." },
      ],
    },
    {
      id: "b",
      label: "Behind the scenes",
      angle: "Show the team at work.",
      ideas: [
        { topic: "Meet the team", captionIdea: "Who we are." },
        { topic: "A day in the studio", captionIdea: "Tools and habits." },
      ],
    },
  ],
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

function render(
  card: PlanOptionsCardData = CARD,
  host: Partial<WorkCardHostInput> | null = {},
) {
  const inner = createElement(PlanOptionsCard, { card, commandId: "cmd1" });
  return renderToStaticMarkup(
    host === null
      ? inner
      : createElement(
          WorkCardHostProvider,
          { value: { ...HOST, ...host } },
          inner,
        ),
  );
}

const optionRegion = (html: string, label: string) => {
  const start = html.indexOf(`aria-label="Direction: ${label}"`);
  const end = html.indexOf('aria-label="Direction: ', start + 10);
  return html.slice(start, end === -1 ? undefined : end);
};

describe("PlanOptionsCard (W76 options-card)", () => {
  it("renders every option in a labelled region inside the directions group", () => {
    const html = render();
    expect(html).toContain('data-card="content-plan-options"');
    expect(html).toContain('aria-label="Plan directions"');
    expect(html).toContain('aria-label="Direction: Education first"');
    expect(html).toContain('aria-label="Direction: Behind the scenes"');
    expect(html).toContain("Three ways to open the week.");
    expect(html).toContain("Pick a direction");
    expect(html).toContain("Checked against 4 brand rules.");
    expect(html).not.toContain("border-dashed");
  });

  it("shows label, angle, post count, channels, provenance and first topic per option", () => {
    const html = render();
    const a = optionRegion(html, "Education first");
    expect(a).toContain("font-semibold");
    expect(a).toContain("Teach the one thing clients ask about most.");
    expect(a).toContain("line-clamp-2");
    expect(a).toContain("2 posts");
    expect(a).toContain("Instagram");
    expect(a).toContain("LinkedIn");
    expect(a).toContain("Based on: Top question: pricing");
    expect(a).toContain("Starts with: Pricing explained");
    const b = optionRegion(html, "Behind the scenes");
    expect(b).not.toContain("Based on:");
    expect(b).toContain("Starts with: Meet the team");
  });

  it("lists every topic in a native disclosure with a 44 px summary", () => {
    const html = render();
    const a = optionRegion(html, "Education first");
    expect(a).toContain("<details");
    expect(a).toContain("min-h-11");
    expect(a).toContain("See all 2 topics");
    expect(a).toContain("<ol");
    expect(a).toContain("<li>Pricing explained</li>");
    expect(a).toContain("<li>Three myths</li>");
  });

  it("says 1 post for a single slot", () => {
    const html = render({
      ...CARD,
      slots: [CARD.slots[0]!],
      options: CARD.options.map((o) => ({ ...o, ideas: [o.ideas[0]!] })),
    });
    expect(html).toContain("1 post");
    expect(html).not.toContain("1 posts");
  });

  it("has exactly one primary Use this direction button per option region", () => {
    const html = render();
    for (const label of ["Education first", "Behind the scenes"]) {
      const region = optionRegion(html, label);
      expect(count(region, 'data-emphasis="primary"')).toBe(1);
      expect(count(region, "Use this direction")).toBe(1);
      expect(region).toContain("min-h-11");
      expect(region).toContain("w-full");
      expect(region).toContain("sm:w-auto");
    }
    expect(count(html, "Use this direction")).toBe(2);
    expect(count(html, 'data-emphasis="primary"')).toBe(2);
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("shows the footnote and three quiet one-tap chips", () => {
    const html = render();
    expect(html).toContain("Not quite right? Tell me what to change.");
    expect(count(html, 'data-emphasis="quiet"')).toBe(3);
    expect(html).toContain("More playful");
    expect(html).toContain("More educational");
    expect(html).toContain("Shorter");
    expect(html).toMatch(/role="group"[^>]*aria-labelledby/);
  });

  it("renders an old card without basis or brandCheck", () => {
    const old: PlanOptionsCardData = {
      ...CARD,
      brandCheck: undefined,
      options: CARD.options.map((o) => ({
        id: o.id,
        label: o.label,
        angle: o.angle,
        ideas: o.ideas,
      })),
    };
    const html = render(old);
    expect(html).not.toContain("Based on:");
    expect(html).not.toContain("brand rules");
    expect(html).toContain("Use this direction");
  });

  it("shows brand.unavailable when the rules could not be loaded", () => {
    expect(render({ ...CARD, brandCheck: { state: "skipped" } })).toContain(
      "Brand rules couldn&#x27;t be checked.",
    );
  });

  it("blocks every button with ONE visible reason when the Work is completed", () => {
    const html = render(CARD, { active: false });
    const reason = "This Work is completed. Reopen it to continue.";
    expect(count(html, reason)).toBe(1);
    // 2 pick buttons + 3 chips.
    expect(count(html, 'aria-disabled="true"')).toBe(5);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).not.toContain("Show the newer card");
  });

  it("blocks only the chips while a chat turn streams", () => {
    const html = render(CARD, { busy: true });
    expect(count(html, "Wait for the reply to finish.")).toBe(1);
    expect(count(html, 'aria-disabled="true"')).toBe(3);
    expect(html).toContain("Use this direction");
  });

  it("a superseded card is dashed, blocked, and offers the newer card", () => {
    const html = render({ ...CARD, state: "superseded" });
    expect(html).toContain("border-dashed");
    expect(html).toContain("Replaced by a newer version");
    expect(html).not.toContain("Pick a direction");
    expect(count(html, 'aria-disabled="true"')).toBe(5);
    expect(count(html, "These directions were replaced by a newer card.")).toBe(
      1,
    );
    expect(html).toContain("Show the newer card");
  });

  it("returns nothing outside a Work", () => {
    expect(render(CARD, null)).toBe("");
  });
});

describe("mapPickResult (W76 options-card)", () => {
  it("announces the plan on success and never asks for a refresh", () => {
    expect(mapPickResult({ ok: true, title: "t" }, "Education first")).toEqual({
      result: { ok: true, message: "Plan ready: Education first." },
      refresh: false,
    });
    expect(
      mapPickResult({ ok: true, alreadyPicked: true, title: "t" }, "A").refresh,
    ).toBe(false);
  });

  it("maps PICKED (with a refresh), STATE, WORK and the rest", () => {
    const fail = (code: "PICKED" | "STATE" | "WORK" | "FAILED" | "RATE") =>
      mapPickResult({ ok: false, code, message: "server text" }, "A");
    expect(fail("PICKED")).toMatchObject({
      result: {
        ok: false,
        message: "A direction was already picked for this plan.",
      },
      refresh: true,
    });
    expect(fail("STATE")).toMatchObject({
      result: {
        ok: false,
        message: "These directions were replaced by a newer card.",
      },
      refresh: false,
    });
    expect(fail("WORK").result).toMatchObject({
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(fail("FAILED").result).toMatchObject({
      message: "Couldn't build the plan. Try again.",
    });
    expect(fail("RATE").result).toMatchObject({
      message: "Couldn't build the plan. Try again.",
    });
  });

  it("never reports STALE or CONFLICT (the kit would refresh the page)", () => {
    const codes = (["PICKED", "STATE", "WORK", "FAILED"] as const).map(
      (code) => {
        const { result } = mapPickResult(
          { ok: false, code, message: "x" },
          "A",
        );
        return result.ok ? null : result.code;
      },
    );
    expect(codes).not.toContain("STALE");
    expect(codes).not.toContain("CONFLICT");
  });
});

describe("shouldCancelFocus", () => {
  it("drops the focus request after a failed pick", () => {
    expect(
      shouldCancelFocus({
        result: { ok: false, code: "STATE", message: "x" },
        refresh: false,
      }),
    ).toBe(true);
  });

  it("keeps it after a success or a PICKED refresh (a plan card is coming)", () => {
    expect(shouldCancelFocus({ result: { ok: true }, refresh: false })).toBe(
      false,
    );
    expect(
      shouldCancelFocus({
        result: { ok: false, code: "PICKED", message: "x" },
        refresh: true,
      }),
    ).toBe(false);
  });
});
