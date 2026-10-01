import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/work-actions", () => ({
  setWorkChannelsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { WorkStart } = await import("./work-start");
const { buildWorkHost } = await import("@/lib/works/host");

type Keys = Parameters<typeof buildWorkHost>[0]["connections"];

const connected = (...keys: string[]): Keys =>
  Object.fromEntries(
    keys.map((k) => [k, { connected: true, accountLabel: `@${k}` }]),
  ) as Keys;

const render = (connections: Keys, channels: string[] = []) => {
  const host = buildWorkHost({
    projectId: "p1",
    work: {
      id: "w1",
      title: "Work",
      summary: null,
      status: "ACTIVE",
      channels,
      acknowledgedUnconnected: [],
      lastActivityAt: "2026-10-01T00:00:00.000Z",
    } as Parameters<typeof buildWorkHost>[0]["work"],
    connections,
    pendingApprovals: 0,
    hasAnalytics: false,
  });
  return renderToStaticMarkup(
    createElement(WorkStart, {
      projectId: "p1",
      host,
      disabled: false,
      onAct: () => undefined,
      onChannelsSaved: () => undefined,
    }),
  );
};

const pressed = (html: string) => (html.match(/aria-pressed="true"/g) ?? []).length;

describe("WorkStart channel pre-selection", () => {
  it("pre-ticks two connected channels", () => {
    expect(pressed(render(connected("instagram", "linkedin")))).toBe(2);
  });

  it("ticks nothing when four are connected", () => {
    expect(
      pressed(render(connected("instagram", "linkedin", "x", "tiktok"))),
    ).toBe(0);
  });

  it("ticks nothing when none is connected", () => {
    expect(pressed(render({}))).toBe(0);
  });

  it("shows the starter cards once the Work has channels", () => {
    const html = render(connected("instagram"), ["instagram"]);
    expect(html).toContain("What do you want to do?");
    expect(html).not.toContain("aria-pressed");
  });
});
