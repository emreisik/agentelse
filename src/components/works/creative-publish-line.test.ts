import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CreativePublishLine as PublishLine } from "@/lib/works/publish-guard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/publish-actions", () => ({
  publishCreativeToInstagramAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  enablePlanPublishingAction: vi.fn(),
}));
vi.mock("@/server/actions/schedule-slots-actions", () => ({
  moveSlotAction: vi.fn(),
}));
vi.mock("@/server/actions/slot-suggest-actions", () => ({
  suggestSlotsAction: vi.fn(),
}));

const {
  CreativePublishLine,
  gateButton,
  isInstagramConnected,
  publishLineButtons,
  publishLineText,
  stepPublishMode,
  whenLabelOf,
} = await import("./creative-publish-line");
const { WorkCardHostProvider } = await import("./work-card-host");

const ISO = "2026-10-09T08:00:00.000Z"; // 11:00 in Europe/Istanbul

function render(
  line: PublishLine | undefined,
  opts: { connected?: boolean; active?: boolean } = {},
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
          channels: [
            {
              key: "instagram",
              label: "Instagram",
              connected: opts.connected ?? true,
            },
          ],
          openTab: () => undefined,
          runNextStep: () => undefined,
        },
      },
      createElement(CreativePublishLine, {
        card: { creativeId: "c1", platform: "INSTAGRAM", publishLine: line },
      }),
    ),
  );
}

const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)].map(
    (m) => m[1],
  );

describe("CreativePublishLine (W79 publish-line)", () => {
  it("renders nothing without a publishLine or without a host", () => {
    expect(render(undefined)).not.toContain("data-publish-line");
    expect(
      renderToStaticMarkup(
        createElement(CreativePublishLine, {
          card: { creativeId: "c1", publishLine: { kind: "published" } },
        }),
      ),
    ).toBe("");
  });

  it("formats the planned time on the project wall clock", () => {
    expect(whenLabelOf(ISO, "Europe/Istanbul")).toBe("Fri 9 Oct, 11:00");
    expect(whenLabelOf(ISO)).toBe("Fri 9 Oct, 11:00");
  });

  it("writes the review consequence of every kind", () => {
    const text = (
      consequence: "scheduled" | "scheduled-off" | "held" | "manual" | "locked",
      extra = {},
    ) => publishLineText({ kind: "review", consequence, ...extra });
    expect(text("scheduled", { plannedFor: ISO })).toBe(
      "If you approve, it goes out on or after Fri 9 Oct, 11:00.",
    );
    expect(text("scheduled")).toBe(
      "If you approve, it goes out at the next scheduled slot.",
    );
    expect(text("scheduled-off", { plannedFor: ISO })).toBe(
      "If you approve, it stays ready until you turn on scheduled posting.",
    );
    expect(text("held")).toBe(
      "If you approve, it waits on hold until you set a time.",
    );
    expect(text("manual")).toBe(
      "You post this one yourself. Approving marks it ready.",
    );
    expect(text("locked", { channel: "linkedin" })).toBe(
      "LinkedIn isn't connected, so this can't post itself.",
    );
  });

  it("scheduled uses 'on or after' and only offers Turn on without a schedule", () => {
    const released = render({
      kind: "scheduled",
      plannedFor: ISO,
      released: true,
    });
    expect(released).toContain("Goes out on or after Fri 9 Oct, 11:00.");
    expect(buttonLabels(released)).toEqual([]);
    expect(render({ kind: "scheduled", released: true })).toContain(
      "Goes out at the next scheduled slot.",
    );
    const off = render({ kind: "scheduled", plannedFor: ISO, released: false });
    expect(off).toContain(
      "Planned for Fri 9 Oct, 11:00, but scheduled posting is off.",
    );
    expect(buttonLabels(off)).toEqual(["Turn on scheduled posting"]);
    expect(
      buttonLabels(render({ kind: "review", consequence: "scheduled-off" })),
    ).toEqual(["Turn on scheduled posting"]);
  });

  it("held offers Set a time (primary) and a quiet Post now only when connected", () => {
    const html = render({ kind: "held", reason: "no-time" });
    expect(html).toContain("On hold: no publish time is set.");
    expect(buttonLabels(html)).toEqual(["Set a time", "Post now"]);
    expect(html).toMatch(
      /data-emphasis="primary"[^>]*>(?:<svg.*?<\/svg>)?Set a time/,
    );
    expect(html).toMatch(
      /data-emphasis="quiet"[^>]*>(?:<svg.*?<\/svg>)?Post now/,
    );
    expect(render({ kind: "held", reason: "past-time" })).toContain(
      "On hold: its planned time has passed.",
    );
    expect(
      buttonLabels(
        render({ kind: "held", reason: "no-time" }, { connected: false }),
      ),
    ).toEqual(["Set a time"]);
  });

  it("Post now is two-step: the first tap only asks, the second posts", () => {
    const first = stepPublishMode("idle", "post-now");
    expect(first).toEqual({ mode: "confirm", post: false });
    expect(stepPublishMode("confirm", "cancel")).toEqual({
      mode: "idle",
      post: false,
    });
    expect(stepPublishMode(first.mode, "confirm-post")).toEqual({
      mode: "idle",
      post: true,
    });
    // A confirm tap without a prior ask never posts.
    expect(stepPublishMode("idle", "confirm-post").post).toBe(false);
    expect(stepPublishMode("idle", "try-again").post).toBe(false);
    expect(stepPublishMode("idle", "set-time")).toEqual({
      mode: "time",
      post: false,
    });
  });

  it("publishing has no buttons and is aria-busy", () => {
    const html = render({ kind: "publishing" });
    expect(html).toContain("Posting to Instagram…");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("<button");
  });

  it("failed shows the reason or the generic text, never 'goes out'", () => {
    const why = render({ kind: "failed", reason: "Token expired" });
    expect(why).toContain("Couldn&#x27;t post to Instagram: Token expired");
    expect(why).not.toMatch(/goes out/i);
    expect(buttonLabels(why)).toEqual(["Try again", "Set a time"]);
    const plain = render({ kind: "failed" });
    expect(plain).toContain("Couldn&#x27;t post to Instagram.");
    expect(plain).not.toMatch(/goes out/i);
    expect(publishLineText({ kind: "publishing" })).not.toMatch(/goes out/i);
  });

  it("manual shows Post it, which hands a publish_manual step to the host", () => {
    const html = render({ kind: "manual", plannedFor: ISO });
    expect(html).toContain("Yours to post on Fri 9 Oct, 11:00.");
    expect(buttonLabels(html)).toEqual(["Post it"]);
    const buttons = publishLineButtons(
      { kind: "manual" },
      { projectId: "p1", workId: "w1", instagramConnected: true },
    );
    expect(buttons[0]?.id).toBe("post-it");
  });

  it("locked links to the integration with the Work to return to", () => {
    const html = render({ kind: "locked", channel: "linkedin" });
    expect(html).toContain("LinkedIn isn&#x27;t connected yet.");
    expect(html).toContain("Connect LinkedIn");
    expect(html).toContain(
      'href="/projects/p1/integrations?integration=linkedin&amp;from=w1"',
    );
  });

  it("published reads Published. with no buttons", () => {
    const html = render({ kind: "published" });
    expect(html).toContain("Published.");
    expect(html).not.toContain("<button");
  });

  it("never shows more than three buttons or two primaries", () => {
    const kinds: PublishLine[] = [
      { kind: "held", reason: "no-time" },
      { kind: "failed" },
      { kind: "manual" },
      { kind: "locked", channel: "x" },
      { kind: "scheduled", released: false },
    ];
    for (const line of kinds) {
      const html = render(line);
      expect(buttonLabels(html).length).toBeLessThanOrEqual(3);
      expect(
        html.split('data-emphasis="primary"').length - 1,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("blocks server buttons with the reason in a completed Work", () => {
    const html = render({ kind: "held", reason: "no-time" }, { active: false });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("This Work is completed. Reopen it to continue.");
  });
});

describe("gateButton", () => {
  const server = (id: string) => ({
    id,
    label: id,
    emphasis: "primary" as const,
    action: { kind: "server" as const, id },
  });

  it("blocks a server button with the reason", () => {
    expect(gateButton(server("confirm-post"), "Work is done")).toMatchObject({
      disabledReason: "Work is done",
    });
  });

  it("never blocks Cancel (it only closes the open panel)", () => {
    expect(gateButton(server("cancel"), "Work is done").disabledReason).toBe(
      undefined,
    );
  });

  it("leaves a button alone when there is no reason", () => {
    expect(gateButton(server("confirm-post"), null).disabledReason).toBe(
      undefined,
    );
  });
});

describe("isInstagramConnected", () => {
  it("reads the project's connections, not the Work's channels", () => {
    expect(
      isInstagramConnected({
        channels: [{ key: "linkedin", label: "LinkedIn", connected: true }],
        connectedChannels: ["instagram"],
      }),
    ).toBe(true);
    expect(
      isInstagramConnected({
        channels: [{ key: "instagram", label: "Instagram", connected: true }],
        connectedChannels: ["linkedin"],
      }),
    ).toBe(false);
  });

  it("falls back to the Work's channels without the project list", () => {
    expect(
      isInstagramConnected({
        channels: [{ key: "instagram", label: "Instagram", connected: true }],
      }),
    ).toBe(true);
    expect(isInstagramConnected({ channels: [] })).toBe(false);
  });
});
