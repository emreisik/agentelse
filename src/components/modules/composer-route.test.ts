import { afterEach, describe, expect, it, vi } from "vitest";

// The real rules, with a switch to make them throw.
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/modules/route-intent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/modules/route-intent")>();
  return {
    ...actual,
    routeIntent: (text: string) => {
      if (broken.on) throw new Error("boom");
      return actual.routeIntent(text);
    },
  };
});

const { composerRoute } = await import("./composer-route");

afterEach(() => {
  broken.on = false;
});

const base = {
  modulesUi: true,
  blank: true,
  module: null,
  hasFiles: false,
} as const;

describe("composerRoute", () => {
  it("words clearly for the Social Media Planner make the chat that module's (the words are sent as they are)", () => {
    expect(
      composerRoute({
        ...base,
        text: "Plan 3 Instagram posts a week for Black Friday",
      }),
    ).toEqual({ kind: "module", module: "social" });
    expect(
      composerRoute({
        ...base,
        text: "gelecek hafta için 3 instagram postu hazırla",
      }),
    ).toEqual({ kind: "module", module: "social" });
    expect(
      composerRoute({ ...base, text: "3 instagram posts for next week" }),
    ).toEqual({ kind: "module", module: "social" });
  });

  it("a question, small talk or nothing clear stays a chat", () => {
    for (const text of [
      "What should I post this week?",
      "markamızın tonu ne?",
      "hello",
      "",
    ]) {
      expect(composerRoute({ ...base, text })).toEqual({ kind: "chat" });
    }
  });

  it("words for Ads, Analytics or SEO go to the chat: their card opens from a tile and takes no words", () => {
    expect(
      composerRoute({
        ...base,
        text: "Launch a Meta ads campaign with a 500 budget",
      }),
    ).toEqual({ kind: "chat" });
    expect(
      composerRoute({
        ...base,
        text: "Write a blog post about sustainable packaging",
      }),
    ).toEqual({ kind: "chat" });
  });

  it("only a blank chat without a module, with modules on and no files, is routed", () => {
    const text = "Create a post for Instagram";
    expect(composerRoute({ ...base, text })).toMatchObject({ kind: "module" });
    expect(composerRoute({ ...base, text, modulesUi: false })).toEqual({
      kind: "chat",
    });
    expect(composerRoute({ ...base, text, blank: false })).toEqual({
      kind: "chat",
    });
    expect(composerRoute({ ...base, text, module: "social" })).toEqual({
      kind: "chat",
    });
    expect(composerRoute({ ...base, text, hasFiles: true })).toEqual({
      kind: "chat",
    });
  });

  it("a rule that throws never loses the message: it is sent as a chat", () => {
    broken.on = true;
    expect(composerRoute({ ...base, text: "Plan 3 posts" })).toEqual({
      kind: "chat",
    });
  });
});
