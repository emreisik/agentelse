import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const toasts = vi.hoisted(() => ({
  message: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
const approve = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: toasts }));
// Run transitions inline so the hook's async work can be awaited.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => [false, (fn: () => void) => fn()],
  };
});
vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: approve,
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  enablePlanPublishingAction: vi.fn(),
}));

const { NextStepsBar, approvePlansToast, useRunNextStep } = await import(
  "./next-steps-bar"
);

import type { NextStep } from "@/lib/journey";

const step = (over: Partial<NextStep> = {}): NextStep => ({
  key: "produce",
  tone: "next",
  label: "Produce 3",
  title: "3 planned pieces have no content yet.",
  action: { kind: "produce_plan", planId: "plan-1", count: 3 },
  ...over,
});

const render = (props: Partial<Parameters<typeof NextStepsBar>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(NextStepsBar, {
      steps: [step()],
      projectId: "proj-1",
      onAct: vi.fn(),
      ...props,
    }),
  );

describe("NextStepsBar", () => {
  it("renders nothing when there is nothing to advance", () => {
    expect(render({ steps: [] })).toBe("");
  });

  it("says what is next and offers it as the one big button", () => {
    const html = render();
    expect(html).toContain('aria-label="Next steps"');
    expect(html).toContain("3 planned pieces have no content yet.");
    expect(html).toContain("Produce 3");
  });

  it("shows the other steps as quick alternatives", () => {
    const html = render({
      steps: [
        step({ key: "review", label: "Review 2", title: "2 pieces are ready." }),
        step({ key: "produce" }),
        step({
          key: "connect-instagram",
          label: "Connect Instagram",
          action: { kind: "connect_channel", channel: "instagram" },
        }),
      ],
    });
    // The first step is the headline; the rest are chips.
    expect(html).toContain("2 pieces are ready.");
    expect(html).toContain("Review 2");
    expect(html).toContain(">Produce 3<");
    expect(html).toContain("Connect Instagram");
  });

  it("marks something stuck or due differently from the natural next move", () => {
    expect(render({ steps: [step({ tone: "blocker" })] })).toContain(
      "var(--destructive)",
    );
    expect(render({ steps: [step({ tone: "next" })] })).not.toContain(
      "var(--destructive)",
    );
  });

  it("waits while a run or a turn is in progress", () => {
    // The attribute, not the `disabled:` utility classes every button carries.
    const attribute = /<button[^>]*\sdisabled(=""|\s|>)/;
    expect(render({ disabled: true })).toMatch(attribute);
    expect(render({ disabled: false })).not.toMatch(attribute);
  });

  it("can be hidden for now", () => {
    const html = render();
    expect(html).toContain('aria-label="Hide for now"');
  });

  it("keeps quiet steps out: an account that is not connected is not news", () => {
    const connect = step({
      key: "connect-instagram",
      label: "Connect Instagram",
      quiet: true,
      action: { kind: "connect_channel", channel: "instagram" },
    });
    // Alone, it leaves no bar at all.
    expect(render({ steps: [connect] })).toBe("");
    // Next to something waiting, it is not offered either.
    const html = render({ steps: [step(), connect] });
    expect(html).toContain("Produce 3");
    expect(html).not.toContain("Connect Instagram");
  });
});

const approveStep = (): NextStep => ({
  key: "approve",
  tone: "next",
  label: "Approve 3",
  title: "3 pieces are ready.",
  action: {
    kind: "approve_plan",
    planIds: ["p1", "p2"],
    creativeIds: ["c1", "c2", "c3"],
    count: 3,
  },
});

const ok = (over: Partial<{ approved: number; failed: number; held: number; locked: number }> = {}) => ({
  ok: true as const,
  approved: 3,
  failed: 0,
  held: 0,
  locked: 0,
  ...over,
});

describe("approvePlansToast", () => {
  it("covers approved, held, failed, locked and CHANGED", () => {
    expect(approvePlansToast(ok())).toEqual({ kind: "success", text: "3 approved." });
    expect(approvePlansToast(ok({ approved: 2, held: 1 }))).toEqual({
      kind: "success",
      text: "2 approved. 1 on hold until you set a time.",
    });
    expect(approvePlansToast(ok({ approved: 2, failed: 1 }))).toEqual({
      kind: "error",
      text: "2 approved, 1 could not be.",
    });
    expect(approvePlansToast(ok({ locked: 2 })).text).toBe(
      "3 approved. 2 skipped: their Work is completed.",
    );
    expect(
      approvePlansToast({
        ok: false,
        code: "CHANGED",
        message: "2 more pieces are ready. Review them first.",
      }),
    ).toEqual({ kind: "error", text: "2 more pieces are ready. Review them first." });
  });

  it("the bar renders an approve_plan step like any other", () => {
    const html = render({ steps: [approveStep()] });
    expect(html).toContain("Approve 3");
    expect(html).toContain("3 pieces are ready.");
  });
});

describe("useRunNextStep approve_plan", () => {
  const runStep = async (step: NextStep) => {
    let run: (s: NextStep) => void = () => undefined;
    const Probe = () => {
      run = useRunNextStep({
        projectId: "proj-1",
        onProducePlan: vi.fn(),
        onSend: vi.fn(),
      }).run;
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    run(step);
    await new Promise((r) => setTimeout(r, 0));
  };

  it("approves exactly the shown ids and refreshes only on error or CHANGED", async () => {
    vi.clearAllMocks();
    approve.mockResolvedValueOnce(ok());
    await runStep(approveStep());
    expect(approve).toHaveBeenCalledWith("proj-1", {
      planIds: ["p1", "p2"],
      creativeIds: ["c1", "c2", "c3"],
    });
    expect(toasts.success).toHaveBeenCalledWith("3 approved.");
    expect(router.refresh).not.toHaveBeenCalled();

    approve.mockResolvedValueOnce({
      ok: false,
      code: "CHANGED",
      message: "1 more pieces are ready. Review them first.",
    });
    await runStep(approveStep());
    expect(toasts.error).toHaveBeenCalledWith(
      "1 more pieces are ready. Review them first.",
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves other kinds alone", async () => {
    vi.clearAllMocks();
    await runStep(step({ action: { kind: "connect_channel", channel: "instagram" } }));
    expect(approve).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/projects/proj-1/integrations");
  });
});
