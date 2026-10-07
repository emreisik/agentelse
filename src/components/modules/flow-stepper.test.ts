import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FlowStepper, flowStepperAria } from "./flow-stepper";

type Props = Parameters<typeof FlowStepper>[0];

const render = (props: Props) =>
  renderToStaticMarkup(createElement(FlowStepper, props));

type El = { type?: unknown; props?: Record<string, unknown> };
function find(node: unknown, predicate: (el: El) => boolean, out: El[] = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, out);
    return out;
  }
  const el = node as El;
  if (el.props) {
    if (predicate(el)) out.push(el);
    find(el.props.children, predicate, out);
  }
  return out;
}

const labelsOf = (html: string) =>
  [
    ...html.matchAll(
      /<span class="text-xs whitespace-nowrap[^"]*"[^>]*>([^<]+)/g,
    ),
  ].map((match) => match[1]);

describe("FlowStepper", () => {
  it("walks the five standard steps, the last one in the module's own verb", () => {
    expect(labelsOf(render({ module: "social", current: "brief" }))).toEqual([
      "Brief",
      "Plan",
      "Create",
      "Review",
      "Publish",
    ]);
    expect(labelsOf(render({ module: "ads", current: "brief" })).at(-1)).toBe(
      "Launch",
    );
    expect(
      labelsOf(render({ module: "analytics", current: "brief" })).at(-1),
    ).toBe("Share");
  });

  it("is a labelled navigation with the current step marked", () => {
    const html = render({ module: "social", current: "create" });
    expect(html).toContain(`<nav aria-label="${flowStepperAria("social")}"`);
    expect(flowStepperAria("social")).toBe("Social Media Planner steps");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*><span[^>]*>3<\/span>/);
    // Brief and Plan are done: a check, and "done" for screen readers.
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html.match(/, done/g)).toHaveLength(2);
  });

  it("on a phone only the current step keeps its word on screen", () => {
    const html = render({ module: "social", current: "plan" });
    expect(html).toContain(
      '<span class="text-xs whitespace-nowrap font-semibold"',
    );
    expect(html.match(/sr-only sm:not-sr-only/g)).toHaveLength(4);
  });

  it("complete: every step done, none current", () => {
    const html = render({
      module: "social",
      current: "deliver",
      complete: true,
    });
    expect(html).not.toContain("aria-current");
    expect(html.match(/<svg/g)).toHaveLength(5);
  });

  it("only an openable step that is not the current one is a button", () => {
    const onPick = vi.fn();
    const html = render({
      module: "social",
      current: "review",
      openable: { brief: true, plan: true, review: true, deliver: false },
      onPick,
    });
    expect(html.match(/<button/g)).toHaveLength(2);
    // Without onPick nothing is a button.
    expect(
      render({
        module: "social",
        current: "review",
        openable: { brief: true },
      }),
    ).not.toContain("<button");

    const tree = FlowStepper({
      module: "social",
      current: "review",
      openable: { plan: true },
      onPick,
    });
    const [button] = find(tree, (el) => el.type === "button");
    (button?.props?.onClick as () => void)();
    expect(onPick).toHaveBeenCalledWith("plan");
  });
  describe("steps (alt küme)", () => {
    const circlesOf = (html: string) =>
      [...html.matchAll(/<span class="grid size-5[^>]*>(?:<svg|(\d))/g)].map(
        (match) => match[1] ?? "check",
      );

    it("without steps the markup is the one of the five steps", () => {
      const plain = render({ module: "seo", current: "plan" });
      const explicit = render({
        module: "seo",
        current: "plan",
        steps: ["brief", "plan", "create", "review", "deliver"],
      });
      expect(explicit).toBe(plain);
      expect(labelsOf(plain)).toHaveLength(5);
    });

    it("renders only the given steps, numbered by their place in the subset", () => {
      const html = render({
        module: "seo",
        current: "plan",
        steps: ["brief", "plan", "deliver"],
      });
      expect(labelsOf(html)).toEqual(["Brief", "Plan", "Publish"]);
      // Brief done (check), Plan current (2), Publish to do (3).
      expect(circlesOf(html)).toEqual(["check", "2", "3"]);
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(html.match(/, done/g)).toHaveLength(1);
    });

    it("complete marks every shown step done", () => {
      const html = render({
        module: "seo",
        current: "deliver",
        complete: true,
        steps: ["brief", "plan", "deliver"],
      });
      expect(html).not.toContain("aria-current");
      expect(html.match(/<svg/g)).toHaveLength(3);
    });

    it("openable steps outside the subset are not drawn", () => {
      const html = render({
        module: "seo",
        current: "deliver",
        steps: ["brief", "plan", "deliver"],
        openable: { brief: true, plan: true, review: true },
        onPick: vi.fn(),
      });
      expect(html.match(/<button/g)).toHaveLength(2);
    });
  });
});
