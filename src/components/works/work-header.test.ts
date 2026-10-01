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
  }>,
) {
  return renderToStaticMarkup(
    createElement(WorkHeaderView, {
      title: "Spring launch",
      status: over.status ?? "ACTIVE",
      channelsText: "Instagram and X",
      working: over.working ?? false,
      isToday: over.isToday,
      staleDay: over.staleDay,
      openTodayHref: "/projects/p1?work=today",
      onJumpToBrief: noop,
      editing: false,
      draft: "",
      pending: false,
      onDraft: noop,
      onStartEdit: noop,
      onSaveEdit: noop,
      onCancelEdit: noop,
      onChangeChannels: noop,
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
    expect(html).toContain("Instagram and X");
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
    expect(html).not.toContain("Instagram and X");
  });

  it("does not show the working line on a completed Work", () => {
    const html = render({ working: true, status: "DONE" });
    expect(html).toContain('<span role="status" class="sr-only"></span>');
    expect(html).not.toContain(WORK_HEADER_COPY.working);
    expect(html).toContain(WORK_HEADER_COPY.done);
    expect(html).toContain(WORK_HEADER_COPY.reopen);
  });

  it("keeps the copy for the menu, dialog and delete confirm", () => {
    expect(WORK_HEADER_COPY.changeChannels).toBe("Change channels");
    expect(WORK_HEADER_COPY.channelsDialogTitle).toBe("Channels for this Work");
    expect(WORK_HEADER_COPY.channelsDialogNote).toBe(
      "Pieces you already made stay where they are.",
    );
    expect(WORK_HEADER_COPY.channelsSaved).toBe("Channels updated.");
    expect(WORK_HEADER_COPY.deleteConfirm).toBe(
      "Delete this Work and its conversation? Pieces already made stay in your library.",
    );
    expect(WORK_HEADER_COPY.deleteConfirm).not.toMatch(/plans/i);
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

  it("hides Rename, Archive and Delete in the menu but keeps Change channels", () => {
    const html = render({ isToday: true });
    expect(html).not.toContain(WORK_HEADER_COPY.rename);
    expect(html).not.toContain(WORK_HEADER_COPY.archive);
    expect(html).not.toContain(WORK_HEADER_COPY.delete);
    expect(html).toContain(WORK_HEADER_COPY.changeChannels);
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
      WORK_HEADER_COPY.changeChannels,
      WORK_HEADER_COPY.archive,
      WORK_HEADER_COPY.delete,
    ]) {
      expect(html).toContain(item);
    }
    expect(html).not.toContain("Today&#x27;s brief");
    expect(html).not.toContain("Open today");
  });
});
