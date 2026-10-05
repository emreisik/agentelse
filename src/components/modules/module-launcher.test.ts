import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MODULES, type ModuleKey } from "@/lib/modules/catalog";

import {
  MODULE_LAUNCHER_COPY as COPY,
  ModuleLauncher,
  launcherTileOf,
} from "./module-launcher";

const render = (over: Partial<Parameters<typeof ModuleLauncher>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ModuleLauncher, {
      projectId: "p1",
      onChoose: () => undefined,
      ...over,
    }),
  );

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

// Every module is built; the "not ready" paths stay for a module added later.
// Flips readiness for one test and always puts it back.
function withReady(keys: ModuleKey[], ready: boolean, run: () => void) {
  const defs = keys.map((key) => MODULES[key] as { ready: boolean });
  const was = defs.map((def) => def.ready);
  for (const def of defs) def.ready = ready;
  try {
    run();
  } finally {
    defs.forEach((def, i) => (def.ready = was[i] ?? true));
  }
}

describe("ModuleLauncher", () => {
  it("shows the four modules, each with its label and one-line blurb, in order", () => {
    const html = render();
    expect(html.match(/<li /g)).toHaveLength(4);
    const labels = Object.values(MODULES).map((def) => def.label);
    expect(labels).toEqual([
      "Social Media Planner",
      "Ads Manager",
      "Analytics",
      "SEO Manager",
    ]);
    let at = -1;
    for (const def of Object.values(MODULES)) {
      const next = html.indexOf(def.label);
      expect(next).toBeGreaterThan(at);
      at = next;
      expect(html).toContain(def.blurb);
    }
    expect(html).toContain(`<ul aria-label="${COPY.groupAria}"`);
  });

  it("is 2 by 2 on a phone and 4 across where the chat is wide", () => {
    expect(render()).toContain(
      'class="grid grid-cols-2 gap-2 @3xl:grid-cols-4"',
    );
  });

  it("every module starts here: one Start button per tile, no Coming soon", () => {
    const html = render();
    expect(html.match(/<button/g)).toHaveLength(4);
    for (const def of Object.values(MODULES)) {
      expect(html).toMatch(new RegExp(`<button[^>]*>.*${def.label}.*Start`));
      expect(launcherTileOf(def.key, "p1")).toEqual({ kind: "start" });
    }
    expect(html).not.toContain(COPY.comingSoon);
    expect(html).not.toContain('href="/projects/p1/ads"');
  });

  it("a module that is not ready says Coming soon; Ads falls back to the Ads account page", () => {
    withReady(["ads", "analytics"], false, () => {
      expect(launcherTileOf("analytics", "p1")).toEqual({ kind: "soon" });
      expect(launcherTileOf("ads", "p1")).toEqual({
        kind: "link",
        href: "/projects/p1/ads",
      });
      const html = render();
      expect(html.match(/<button/g)).toHaveLength(2);
      expect(html.match(new RegExp(COPY.comingSoon, "g"))).toHaveLength(1);
      expect(html).toMatch(
        /<a [^>]*href="\/projects\/p1\/ads"[^>]*>.*Ads Manager.*Open Ads account/,
      );
    });
    expect(launcherTileOf("ads", "p1")).toEqual({ kind: "start" });
  });

  it("a tap on a tile chooses its module", () => {
    const onChoose = vi.fn();
    const tree = ModuleLauncher({ projectId: "p1", onChoose });
    const buttons = find(tree, (el) => el.type === "button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) (button.props?.onClick as () => void)();
    expect(onChoose.mock.calls.map(([key]) => key)).toEqual([
      "social",
      "ads",
      "analytics",
      "seo",
    ]);
  });

  it("the focus comes back to the first tile that starts here", () => {
    const ref = vi.fn();
    const tree = ModuleLauncher({
      projectId: "p1",
      onChoose: () => undefined,
      firstTileRef: ref,
    });
    const [button] = find(tree, (el) => el.type === "button");
    expect(button?.props?.ref).toBe(ref);
  });

  it("is disabled while a message is being sent", () => {
    const html = render({ disabled: true });
    expect(html.match(/ disabled=""/g)).toHaveLength(4);
    // A dimmed tile does not light up under the pointer.
    expect(html).toContain("enabled:hover:bg-[var(--ws-hover)]");
  });
});
