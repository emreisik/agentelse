import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CardButton } from "@/lib/works/card-action";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Static markup cannot click, so the Button is replaced by a recorder that
// keeps each onClick prop; the test then invokes it like a tap would.
const clicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/components/ui/button", () => ({
  buttonVariants: () => "",
  Button: (props: {
    "data-emphasis"?: string;
    onClick?: () => void;
    children?: ReactNode;
  }) => {
    const label = String(props.children ?? "");
    if (props.onClick) clicks.set(label || "?", props.onClick);
    return null;
  },
}));

const { CardActions } = await import("./card-actions");

const SERVER: CardButton = {
  id: "add",
  label: "Add",
  emphasis: "primary",
  action: { kind: "server", id: "add" },
};
function press(
  over: Partial<Parameters<typeof CardActions>[0]>,
  onAct: (button: CardButton) => void,
): void {
  clicks.clear();
  renderToStaticMarkup(
    createElement(CardActions, { buttons: [SERVER], onAct, ...over }),
  );
  const click = [...clicks.values()][0];
  expect(click).toBeTypeOf("function");
  click?.();
}

describe("CardActions click guard", () => {
  beforeEach(() => clicks.clear());

  it("an enabled server button calls onAct once", () => {
    const onAct = vi.fn();
    press({}, onAct);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith(SERVER);
  });

  it("a button blocked by disabledAll never calls onAct", () => {
    const onAct = vi.fn();
    press({ disabledAll: true, disabledReason: "Work is done" }, onAct);
    expect(onAct).not.toHaveBeenCalled();
  });

  it("a button with its own disabledReason never calls onAct", () => {
    const onAct = vi.fn();
    press({ buttons: [{ ...SERVER, disabledReason: "Not now" }] }, onAct);
    expect(onAct).not.toHaveBeenCalled();
  });

  it("a button never calls onAct while another action runs", () => {
    const onAct = vi.fn();
    press({ busyId: "other" }, onAct);
    expect(onAct).not.toHaveBeenCalled();
  });
});
