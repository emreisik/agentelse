import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/work-actions", () => ({
  archiveWorkAction: vi.fn(),
  completeWorkAction: vi.fn(),
  deleteWorkAction: vi.fn(),
  renameWorkAction: vi.fn(),
  reopenWorkAction: vi.fn(),
  setWorkChannelsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The menu content is portaled and unmounted while closed: render it inline so
// the items it holds can be asserted.
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: passthrough,
  };
});

import { WORK_HEADER_COPY, WorkHeaderView } from "./work-header";

const noop = () => {};
function render(
  over: Partial<{
    working: boolean;
    status: "ACTIVE" | "DONE";
    isToday: boolean;
    staleDay: boolean;
    untouched: boolean;
  }>,
) {
  return renderToStaticMarkup(
    createElement(WorkHeaderView, {
      title: "Spring launch",
      status: over.status ?? "ACTIVE",
      working: over.working ?? false,
      isToday: over.isToday,
      staleDay: over.staleDay,
      untouched: over.untouched,
      openTodayHref: "/projects/p1?work=today",
      onJumpToBrief: noop,
      editing: false,
      draft: "",
      pending: false,
      onDraft: noop,
      onStartEdit: noop,
      onSaveEdit: noop,
      onCancelEdit: noop,
      onComplete: noop,
      onReopen: noop,
      onArchive: noop,
      onDelete: noop,
    }),
  );
}

describe("WorkHeaderView", () => {
  it("shows the channels text and an empty live region when idle", () => {
    const html = render({});
    expect(html).toContain(WORK_HEADER_COPY.active);
    expect(html).toContain('<span role="status" class="sr-only"></span>');
    expect(html).not.toContain(WORK_HEADER_COPY.working);
    expect(html).toContain(WORK_HEADER_COPY.complete);
  });

  it("shows a live working status while working", () => {
    const html = render({ working: true });
    expect(html).toContain(
      `<span role="status" class="sr-only">${WORK_HEADER_COPY.working}</span>`,
    );
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain(WORK_HEADER_COPY.active);
  });

  it("does not show the working line on a completed Work", () => {
    const html = render({ working: true, status: "DONE" });
    expect(html).toContain('<span role="status" class="sr-only"></span>');
    expect(html).not.toContain(WORK_HEADER_COPY.working);
    expect(html).toContain(WORK_HEADER_COPY.done);
    expect(html).toContain(WORK_HEADER_COPY.reopen);
  });

  it("keeps the copy for the delete confirm", () => {
    expect(WORK_HEADER_COPY.deleteConfirm).toBe(
      "Delete this Work and its conversation? Pieces already made stay in your library.",
    );
    expect(WORK_HEADER_COPY.deleteConfirm).not.toMatch(/plans/i);
  });
});

// A new chat nobody has written in has nothing to complete, rename, archive or
// delete: the bar shows only the title and the status line (ChatGPT's new chat).
describe("WorkHeaderView of a new (untouched) chat", () => {
  // The menu is rendered inline in this file (its trigger is a passthrough that
  // drops the aria-label), so it is detected by its items and by its icon.
  const MENU_ITEMS = [
    WORK_HEADER_COPY.rename,
    WORK_HEADER_COPY.archive,
    WORK_HEADER_COPY.delete,
  ];

  it("shows the title and the status line, and none of the actions", () => {
    const html = render({ untouched: true });
    expect(html).toContain("Spring launch");
    expect(html).toContain(WORK_HEADER_COPY.active);
    for (const action of [
      WORK_HEADER_COPY.complete,
      WORK_HEADER_COPY.reopen,
      ...MENU_ITEMS,
    ]) {
      expect(html).not.toContain(action);
    }
    // No button, and no icon: neither Complete's check nor the menu's dots.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
  });

  it("has the actions back once it is used", () => {
    for (const untouched of [false, undefined]) {
      const html = render({ untouched });
      expect(html).toContain(WORK_HEADER_COPY.complete);
      for (const item of MENU_ITEMS) expect(html).toContain(item);
      expect(html).toContain("<svg");
    }
  });

  it("never hides the actions of a completed or a Today Work, whatever the flag says", () => {
    const done = render({ untouched: true, status: "DONE" });
    expect(done).toContain(WORK_HEADER_COPY.reopen);
    for (const item of MENU_ITEMS) expect(done).toContain(item);

    const today = render({ untouched: true, isToday: true });
    expect(today).toContain("Today&#x27;s brief");
  });

  it("still shows what the agent is doing on it", () => {
    const html = render({ untouched: true, working: true });
    expect(html).toContain(WORK_HEADER_COPY.working);
  });
});

// The "…" menu content only mounts when open, so the Today rules are checked on
// the always-rendered header buttons and, for the menu, through a forced-open
// dropdown.
describe("WorkHeaderView of a Today Work", () => {
  it("has no Complete or Reopen, and offers the Today's brief jump button on today's Work", () => {
    const html = render({ isToday: true });
    expect(html).not.toContain(WORK_HEADER_COPY.complete);
    expect(html).not.toContain(WORK_HEADER_COPY.reopen);
    expect(html).toContain("Today&#x27;s brief");
    expect(html).not.toContain("Open today");
  });

  it("has no Rename, Archive or Delete menu at all", () => {
    const html = render({ isToday: true });
    expect(html).not.toContain(WORK_HEADER_COPY.rename);
    expect(html).not.toContain(WORK_HEADER_COPY.archive);
    expect(html).not.toContain(WORK_HEADER_COPY.delete);
    expect(html).not.toContain(WORK_HEADER_COPY.menuAria);
  });

  it("never offers Reopen or Complete on a stale Today Work, only the way to today", () => {
    const html = render({ isToday: true, staleDay: true });
    expect(html).not.toContain(WORK_HEADER_COPY.complete);
    expect(html).not.toContain(WORK_HEADER_COPY.reopen);
    expect(html).not.toContain("Today&#x27;s brief");
    expect(html).toContain('href="/projects/p1?work=today"');
    expect(html).toContain("Open today");
  });

  it("leaves an ordinary Work unchanged: Complete, no jump button, no Open today", () => {
    const html = render({});
    expect(html).toContain(WORK_HEADER_COPY.complete);
    for (const item of [
      WORK_HEADER_COPY.rename,
      WORK_HEADER_COPY.archive,
      WORK_HEADER_COPY.delete,
    ]) {
      expect(html).toContain(item);
    }
    expect(html).not.toContain("Today&#x27;s brief");
    expect(html).not.toContain("Open today");
  });
});
