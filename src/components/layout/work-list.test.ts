import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  pathname: "/projects/proj-1",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: vi.fn(),
}));

const {
  NewChatView,
  RecentsView,
  applyNewWorkResult,
  sidebarSelection,
  workHref,
} = await import("./work-list");
const { createRecentsAnnouncer, visibleRecents } = await import(
  "@/lib/works/recents-announcer"
);
const { SidebarNav } = await import("./sidebar-nav");

const WORKS = [
  {
    id: "w1",
    title: "Weekly Plan",
    summary: "8 posts planned",
    status: "ACTIVE",
  },
  { id: "w2", title: "SEO · AF Treatment", summary: null, status: "DONE" },
] as const;

const recents = (over: Partial<Parameters<typeof RecentsView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RecentsView, {
      projectId: "proj-1",
      works: WORKS,
      activeWorkId: "w1",
      ...over,
    }),
  );

describe("RecentsView", () => {
  it("lists title, subtitle and a status dot per chat, linking to ?work=", () => {
    const html = recents();
    expect(html).toContain(">Recents<");
    expect(html).toContain("Weekly Plan");
    expect(html).toContain("8 posts planned");
    expect(html).toContain(`href="${workHref("proj-1", "w1")}"`);
    expect(html).toContain('aria-label="Active"');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain("bg-violet-500");
  });

  it("fills the height left and scrolls on its own, like ChatGPT", () => {
    const html = recents();
    expect(html).toMatch(
      /<div class="[^"]*\bflex-1\b[^"]*" data-slot="work-list"/,
    );
    expect(html).toMatch(
      /<ul [^>]*class="[^"]*\bmin-h-0\b[^"]*\boverflow-y-auto\b[^"]*"/,
    );
  });

  it("gives a chat without a subtitle a neutral one that matches its status", () => {
    const html = recents({
      works: [
        ...WORKS,
        { id: "w3", title: "Fresh", summary: null, status: "ACTIVE" },
      ],
    });
    expect(html).toContain("Active work");
    expect(html).toContain(">Completed<");
  });

  it("marks only the open chat as the current page", () => {
    const html = recents({ activeWorkId: "w2" });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*href="[^"]*w2"/);
  });

  it("names the list by its heading, so it is not an unnamed run of tab stops", () => {
    const html = recents();
    const heading = /<div id="([^"]+)"[^>]*>Recents<\/div>/.exec(html);
    expect(heading).not.toBeNull();
    expect(html).toContain(`<ul aria-labelledby="${heading?.[1]}"`);
  });

  it("a row's focus ring is inset: the list scrolls, so an outer ring would be clipped", () => {
    const html = recents();
    expect(html).toContain("focus-visible:ring-inset");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("outline-none");
  });

  it("says so when there are no chats", () => {
    expect(recents({ works: [] })).toContain("No chats yet");
  });

  it("has no Today row and no New Chat button of its own", () => {
    const html = recents();
    expect(html).not.toContain("Today");
    expect(html).not.toContain("work=today");
    expect(html).not.toContain("New Chat");
    expect(html).not.toContain("<button");
  });
});

describe("NewChatView", () => {
  const view = (over: Partial<Parameters<typeof NewChatView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(NewChatView, {
        active: false,
        creating: false,
        onNew: () => undefined,
        ...over,
      }),
    );
  // The attribute, not the `disabled:` styles in the class list.
  const disabled = /<button[^>]* disabled=""/;

  it("is a line of its own that says New Chat, clickable", () => {
    expect(view()).toMatch(/^<button type="button"/);
    expect(view()).toContain(">New Chat<");
    expect(view()).not.toContain("New Work");
    expect(view()).not.toMatch(disabled);
    expect(view()).toContain("cursor-pointer");
  });

  it("selected (the new chat is on screen): not clickable, and not dimmed", () => {
    const html = view({ active: true });
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(disabled);
    expect(html).toContain("bg-sidebar-accent");
    expect(html).not.toMatch(/class="[^"]*\bopacity-60\b/);
    expect(view()).not.toContain("aria-current");
  });

  it("dimmed and not clickable only while a chat is being opened", () => {
    const html = view({ creating: true });
    expect(html).toMatch(disabled);
    expect(html).toMatch(/class="[^"]*\bopacity-60\b/);
    expect(view()).not.toMatch(/class="[^"]*\bopacity-60\b/);
  });
});

describe("sidebarSelection", () => {
  const select = (
    pathname: string,
    search: string,
    openWorkUntouched = false,
    recents: readonly { id: string }[] = WORKS,
  ) =>
    sidebarSelection({
      projectId: "proj-1",
      pathname,
      search: new URLSearchParams(search),
      recents,
      openWorkUntouched,
    });

  it("a chat in Recents: that row is open, New Chat is not", () => {
    expect(select("/projects/proj-1", "work=w2")).toEqual({
      activeWorkId: "w2",
      newChatActive: false,
    });
  });

  it("the untouched chat (the server says so) or the bare URL: New Chat is the open line", () => {
    expect(select("/projects/proj-1", "work=wBlank", true)).toEqual({
      activeWorkId: "wBlank",
      newChatActive: true,
    });
    expect(select("/projects/proj-1", "")).toEqual({
      activeWorkId: null,
      newChatActive: true,
    });
    expect(select("/projects/proj-1", "work=%20%20")).toEqual({
      activeWorkId: null,
      newChatActive: true,
    });
  });

  it("a chat missing from Recents is no new chat by itself (archived, old, a Today brief): New Chat stays clickable", () => {
    for (const id of ["wArchived", "wOld", "today"]) {
      expect(select("/projects/proj-1", `work=${id}`, false)).toEqual({
        activeWorkId: id,
        newChatActive: false,
      });
    }
  });

  it("the moment its first message puts the new chat in Recents, New Chat is clickable again", () => {
    // The server still says untouched until the end of the turn; the list
    // already has the announced row.
    const announcer = createRecentsAnnouncer();
    announcer.sync(WORKS);
    announcer.announce({ projectId: "proj-1", workId: "wBlank", title: "Hi" });
    const announced = visibleRecents(WORKS, announcer.getSnapshot());
    expect(select("/projects/proj-1", "work=wBlank", true, announced)).toEqual({
      activeWorkId: "wBlank",
      newChatActive: false,
    });
  });

  it("a panel, a record or another page: nothing is open", () => {
    for (const [pathname, search] of [
      ["/projects/proj-1", "panel=brand-brain&work=w1"],
      ["/projects/proj-1", "entity=idea:i1"],
      ["/projects/proj-1/takvim", "work=w1"],
      ["/projects/proj-2", "work=w1"],
      ["/projects/proj-1/takvim", ""],
    ] as const) {
      expect(select(pathname, search, true)).toEqual({
        activeWorkId: null,
        newChatActive: false,
      });
    }
  });
});

describe("applyNewWorkResult (what a New Chat tap does with the answer)", () => {
  const handlers = () => ({ push: vi.fn(), error: vi.fn() });

  it("goes to the chat and says nothing, whether it is new or the project's blank one", () => {
    const h = handlers();
    applyNewWorkResult("proj-1", { ok: true, workId: "w9" }, h);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith(workHref("proj-1", "w9"));
    expect(h.error).not.toHaveBeenCalled();
  });

  it("a refusal: say why, and do not navigate", () => {
    const h = handlers();
    applyNewWorkResult(
      "proj-1",
      { ok: false, message: "Slow down for a moment." },
      h,
    );
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith("Slow down for a moment.");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("a refusal without a message falls back to the standard line", () => {
    const h = handlers();
    applyNewWorkResult("proj-1", { ok: false, message: "" }, h);
    expect(h.error).toHaveBeenCalledWith(
      "Couldn't open a new chat. Try again.",
    );
  });
});

describe("SidebarNav with Works (ChatGPT layout)", () => {
  const render = (
    works?: readonly (typeof WORKS)[number][],
    search = "",
    openWorkUntouched = false,
  ) => {
    nav.pathname = "/projects/proj-1";
    nav.search = search;
    return renderToStaticMarkup(
      createElement(SidebarNav, {
        activeProjectId: "proj-1",
        works,
        openWorkUntouched,
      }),
    );
  };

  it("New Chat on top, then the nav list and Explore, then Recents", () => {
    const html = render(WORKS, "work=w1");
    const order = [
      ">New Chat<",
      "Brand Brain",
      "Content Calendar",
      ">Explore<",
      ">Recents<",
      "Weekly Plan",
    ].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has no Agency Desk, no Today, and no link to the bare project URL", () => {
    const html = render(WORKS, "work=w1");
    expect(html).not.toContain("Agency Desk");
    expect(html).not.toContain("Today");
    expect(html).not.toContain("work=today");
    expect(html).not.toContain('href="/projects/proj-1"');
  });

  it("New Chat and the nav list are one block that keeps its height; only Recents takes what is left", () => {
    const html = render(WORKS, "work=w1");
    expect(html).toMatch(/<nav class="[^"]*\bmin-h-0\b[^"]*"/);
    expect(html.match(/class="shrink-0 space-y-0.5"/g)).toHaveLength(1);
    expect(html).not.toContain("mt-auto");
  });

  // The chain that gives Recents the height the groups leave (and its own
  // scroll): every link is load-bearing, so each is asserted by its tokens.
  it("the height chain: the nav is a column that scrolls only as a last resort, Recents takes the rest and scrolls inside", () => {
    const html = render(WORKS, "work=w1");
    const classesOf = (opening: RegExp) => {
      const tag = opening.exec(html)?.[0] ?? "";
      return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
    };
    const nav = classesOf(/<nav [^>]*>/);
    for (const token of ["flex", "min-h-0", "flex-1", "flex-col", "overflow-y-auto"]) {
      expect(nav, `nav ${token}`).toContain(token);
    }
    const recentsBox = classesOf(/<div [^>]*data-slot="work-list"[^>]*>/);
    for (const token of ["flex", "min-h-[60%]", "flex-1", "flex-col"]) {
      expect(recentsBox, `recents box ${token}`).toContain(token);
    }
    const list = classesOf(/<ul [^>]*aria-labelledby[^>]*>/);
    for (const token of ["min-h-0", "flex-1", "overflow-y-auto"]) {
      expect(list, `recents list ${token}`).toContain(token);
    }
  });

  it("the new chat marks New Chat and makes it unclickable; a listed one marks its row", () => {
    const blank = render(WORKS, "work=wBlank", true);
    expect(blank.match(/aria-current="page"/g)).toHaveLength(1);
    expect(blank).toMatch(/<button[^>]* disabled=""[^>]*aria-current="page"/);
    const listed = render(WORKS, "work=w1");
    expect(listed.match(/aria-current="page"/g)).toHaveLength(1);
    expect(listed).toMatch(/aria-current="page"[^>]*href="[^"]*w1"/);
    expect(listed).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("an archived or old chat (not in Recents, not new): nothing marked, New Chat clickable", () => {
    const html = render(WORKS, "work=wArchived", false);
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("the bare URL (the new chat being opened): New Chat marked and not clickable", () => {
    const html = render(WORKS, "");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*aria-current="page"/);
  });

  it("with Works, the panels keep the chat they were opened from, so Back to chat returns to it", () => {
    const html = render(WORKS, "work=w1");
    expect(html).toContain('href="/projects/proj-1?panel=brand-brain&amp;work=w1"');
    expect(html).toContain('href="/projects/proj-1?panel=ideas&amp;work=w1"');
    // Pages that are not panels are left alone.
    expect(html).toContain('href="/projects/proj-1/takvim"');
  });

  it("without a chat in the URL the panel links are the plain ones", () => {
    const html = render(WORKS, "");
    expect(html).toContain('href="/projects/proj-1?panel=brand-brain"');
    // (The Recents rows link to ?work=<id> themselves; the panels must not.)
    expect(html).not.toContain("&amp;work=");
  });

  it("without Works the panel links never carry a chat, even if the URL has one", () => {
    const html = render(undefined, "work=w1");
    expect(html).toContain('href="/projects/proj-1?panel=brand-brain"');
    expect(html).not.toContain("work=w1");
  });

  it("is unchanged without Works: Agency Desk first, no New Chat, no Recents", () => {
    const html = render();
    expect(html).not.toContain("Recents");
    expect(html).not.toContain("New Chat");
    expect(html).toContain("Agency Desk");
    expect(html).toContain('href="/projects/proj-1"');
    expect(html.indexOf("Agency Desk")).toBeLessThan(
      html.indexOf("Brand Brain"),
    );
    expect(html).toContain(">Explore<");
    expect(html).not.toContain("shrink-0 space-y-0.5");
  });
});
