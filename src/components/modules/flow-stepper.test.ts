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
});
