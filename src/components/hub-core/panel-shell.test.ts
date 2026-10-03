import { describe, expect, it, vi } from "vitest";

// The panels are heavy server components (prisma, repositories): only the shell
// around them is under test.
for (const file of [
  "setup-panel",
  "library-panel",
  "brand-brain-panel",
  "ideas-panel",
  "work-panel",
  "departments-panel",
  "human-action-panel",
  "settings-panel",
]) {
  const name = file
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
  vi.doMock(`./panels/${file}`, () => ({ [name]: () => null }));
}
vi.mock("./hub-breadcrumb", () => ({ HubBreadcrumb: () => null }));

const { PanelShell } = await import("./panel-shell");

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

const backHref = async (workId?: string) => {
  const tree = await PanelShell({
    projectId: "p1",
    panel: "settings",
    sub: null,
    entity: null,
    workId,
  });
  const back = find(
    tree,
    (el) => typeof el.props?.href === "string" && typeof el.props?.scroll === "boolean",
  );
  return back[0]?.props?.href as string | undefined;
};

// The bare project URL starts a new chat: "Back to chat" must return to the chat
// the panel was opened from.
describe("PanelShell back link", () => {
  it("returns to the chat the panel was opened from", async () => {
    expect(await backHref("w1")).toBe("/projects/p1?work=w1");
  });

  it("is the project root without one (Works off)", async () => {
    expect(await backHref()).toBe("/projects/p1");
    expect(await backHref("  ")).toBe("/projects/p1");
  });

  it("renders nothing without a panel", async () => {
    expect(
      await PanelShell({ projectId: "p1", panel: null, sub: null, entity: null }),
    ).toBeNull();
  });
});
