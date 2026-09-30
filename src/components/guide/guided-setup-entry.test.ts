import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@assistant-ui/react", () => ({ useAuiState: () => 0 }));

const { GuidedSetupChip, GuidedSetupWelcomeCard } = await import(
  "./guided-setup-entry"
);
const { entryOf } = await import("@/lib/guided-setup/contract");
type Summary = Parameters<typeof entryOf>[0];

const base: Summary = {
  status: "NONE",
  answered: 0,
  total: 5,
  position: 1,
  started: false,
  hasProfile: false,
};
const start = entryOf(base);
const cont = entryOf({ ...base, status: "OPEN", answered: 2, position: 3 });
const update = entryOf({ ...base, hasProfile: true });
const noop = () => {};

const chip = (
  entry = start,
  o: { threadEmpty?: boolean; dismissed?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(GuidedSetupChip, {
      entry,
      threadEmpty: o.threadEmpty ?? false,
      dismissed: o.dismissed ?? false,
      disabled: false,
      onOpen: noop,
      onDismiss: noop,
    }),
  );
const welcome = (entry = start) =>
  renderToStaticMarkup(
    createElement(GuidedSetupWelcomeCard, {
      entry,
      projectName: "Acme",
      disabled: false,
      onOpen: noop,
    }),
  );

describe("guided setup entry (G82)", () => {
  it("labels by kind: start, continue with question n of 5", () => {
    expect(chip(start)).toContain("Set up your brand");
    expect(chip(cont)).toContain("Continue setup · question 3 of 5");
    expect(welcome(start)).toContain("Start setup");
    expect(welcome(start)).toContain("Set up Acme");
    expect(welcome(cont)).toContain("Continue setup");
  });

  it("shows the chip with Not now on a non-empty thread", () => {
    expect(chip()).toContain("Not now");
  });

  it("hides the chip on established projects", () => {
    expect(chip(update)).toBe("");
  });

  it("hides the chip on an empty thread (Welcome is its twin)", () => {
    expect(chip(start, { threadEmpty: true })).toBe("");
    expect(welcome(start)).not.toBe("");
  });

  it("hides the chip once dismissed", () => {
    expect(chip(start, { dismissed: true })).toBe("");
  });

  it("the entry buttons are finger-sized on touch devices", () => {
    const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];
    expect(buttons(welcome(start))).toHaveLength(1);
    expect(buttons(chip())).toHaveLength(2);
    for (const tag of [...buttons(welcome(start)), ...buttons(chip())]) {
      expect(tag).toContain("any-pointer-coarse:min-h-11");
    }
  });

  it("hides the Welcome card for update", () => {
    expect(welcome(update)).toBe("");
  });
});
