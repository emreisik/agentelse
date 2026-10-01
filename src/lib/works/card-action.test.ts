import { describe, expect, it } from "vitest";
import {
  MAX_CARD_BUTTONS,
  isSameOriginPath,
  isSendAction,
  normalizeButtons,
  type CardAction,
  type CardButton,
} from "@/lib/works/card-action";

const tab: CardAction = { kind: "tab", tab: "outputs" };
const b = (
  id: string,
  emphasis: CardButton["emphasis"] = "secondary",
  action: CardAction = tab,
): CardButton => ({ id, label: id, emphasis, action });

describe("normalizeButtons", () => {
  it("keeps one primary, extra primaries become secondary", () => {
    const out = normalizeButtons([b("a", "primary"), b("b", "primary")]);
    expect(out.map((x) => x.emphasis)).toEqual(["primary", "secondary"]);
  });
  it("drops duplicate ids keeping the first", () => {
    const out = normalizeButtons([b("a"), { ...b("a"), label: "x" }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("a");
  });
  it("caps and keeps order", () => {
    const out = normalizeButtons([b("a"), b("b"), b("c"), b("d")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out.length).toBeLessThanOrEqual(MAX_CARD_BUTTONS);
  });
  it("link policy", () => {
    const link = (href: string) => b("l", "secondary", { kind: "link", href });
    expect(normalizeButtons([link("/projects/p1/x")])).toHaveLength(1);
    for (const bad of [
      "javascript:alert(1)",
      "//evil.com",
      "https://x.test",
      "/a\\b",
      " /x",
    ]) {
      expect(normalizeButtons([link(bad)])).toHaveLength(0);
    }
  });
  it("send policy", () => {
    const send = (text: string) => b("s", "secondary", { kind: "send", text });
    expect(normalizeButtons([send("")])).toHaveLength(0);
    expect(normalizeButtons([send("x".repeat(601))])).toHaveLength(0);
    expect(normalizeButtons([send("x".repeat(600))])).toHaveLength(1);
    expect(normalizeButtons([send("a\u0007b")])).toHaveLength(0);
    expect(normalizeButtons([send("line1\nline2")])).toHaveLength(1);
  });
  it("dropped buttons do not use up the cap", () => {
    const bad = b("x", "secondary", { kind: "link", href: "//e.com" });
    const out = normalizeButtons([bad, b("a"), b("b"), b("c")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("helpers", () => {
  it("isSendAction", () => {
    expect(isSendAction({ kind: "send", text: "x" })).toBe(true);
    expect(isSendAction(tab)).toBe(false);
  });
  it("isSameOriginPath", () => {
    expect(isSameOriginPath("/a?b=1")).toBe(true);
    expect(isSameOriginPath("a")).toBe(false);
  });
});
