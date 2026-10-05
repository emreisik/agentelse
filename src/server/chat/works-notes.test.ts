import { describe, expect, it } from "vitest";

import { MAX_OPTION_SLOTS } from "@/lib/works/plan-layout";

import { SKILL_KEYS, SKILLS } from "./skills/registry";
import {
  WORKS_CARD_NOTE,
  WORKS_MODULE_CARD_NOTE,
  WORKS_SOCIAL_PLAN_NOTE,
  WORKS_TOO_LARGE_NOTE,
  worksNotes,
  worksPlanSlotsNote,
} from "./works-notes";
import {
  WORKS_HIDDEN_TOOLS,
  WORKS_PACKAGE_REPLACEMENT,
  worksSkill,
} from "./works-skills";

describe("works-notes", () => {
  it("builds the slots note with one numbered line per slot and the count", () => {
    expect(
      worksPlanSlotsNote(
        ["Mon 5 Oct 10:00 · instagram.post", "Wed 7 Oct 10:00 · linkedin.post"],
        2,
      ),
    ).toBe(
      [
        "Slots for this brief (the server fixed the days; one idea per slot, in this order):",
        "1. Mon 5 Oct 10:00 · instagram.post",
        "2. Wed 7 Oct 10:00 · linkedin.post",
        "Each option needs exactly 2 ideas, in this order.",
      ].join("\n"),
    );
  });

  it("has an earlier-brief variant", () => {
    const note = worksPlanSlotsNote(["a"], 1, true);
    expect(note.split("\n")[0]).toBe(
      "Slots for the plan brief of earlier in this Work (the server fixed the days, rolled forward to today; one idea per slot, in this order):",
    );
    expect(note).toContain("Each option needs exactly 1 ideas, in this order.");
  });

  it("says up front that a brief over the limit uses propose_content_plan", () => {
    const notes = worksNotes({ tooLarge: true });
    expect(notes).toEqual([WORKS_CARD_NOTE, WORKS_TOO_LARGE_NOTE]);
    expect(WORKS_TOO_LARGE_NOTE).toContain(
      `more than ${MAX_OPTION_SLOTS} posts`,
    );
    expect(WORKS_TOO_LARGE_NOTE).toContain("propose_content_plan");
    expect(worksNotes({ tooLarge: false })).toEqual([WORKS_CARD_NOTE]);
  });

  it("returns only the card note without slots", () => {
    expect(worksNotes({})).toEqual([WORKS_CARD_NOTE]);
    expect(worksNotes({ planSlots: [] })).toEqual([WORKS_CARD_NOTE]);
  });

  it("adds the slots note, bounded, when there are slots", () => {
    const slots = Array.from({ length: 25 }, (_, i) => `slot ${i}`);
    const notes = worksNotes({ planSlots: slots, fromEarlierBrief: true });
    expect(notes).toHaveLength(2);
    const slotsNote = notes[1] ?? "";
    expect(slotsNote).toContain("plan brief of earlier");
    expect(slotsNote.split("\n")).toHaveLength(MAX_OPTION_SLOTS + 2);
    expect(slotsNote).toContain(
      `Each option needs exactly ${MAX_OPTION_SLOTS} ideas`,
    );
    expect((notes[0] ?? "").length).toBeLessThan(2500);
  });
});

// Modules (Work.module): only the Social Media Planner and a general chat plan
// and make posts; Ads Manager, Analytics and SEO Manager have none of the post
// tools (tools.ts MODULE_TOOLS), so none of their guidance either.
describe("works-notes in a module chat", () => {
  const POST_TOOLS = [
    "propose_content_plan",
    "propose_plan_options",
    "propose_ideas",
    "propose_master_content",
    "generate_image",
  ];
  const everything = {
    tooLarge: true,
    planSlots: ["Mon 5 Oct 10:00 · instagram.post"],
    ideaPool: [{ id: "i1", title: "Autumn menu", summary: "Seasonal dishes" }],
    postLessons: { worked: ["Short captions"], didNotWork: [] },
  };

  it("keeps the post planning for a general chat and the Social Media Planner", () => {
    for (const key of [undefined, null, "social"] as const) {
      const notes = worksNotes({ ...everything, module: key });
      expect(notes[0]).toBe(WORKS_CARD_NOTE);
      expect(notes).toContain(WORKS_TOO_LARGE_NOTE);
      expect(notes.join("\n")).toContain("Idea pool");
      expect(notes.join("\n")).toContain("Slots for this brief");
    }
    expect(worksNotes({ module: undefined })).toEqual([WORKS_CARD_NOTE]);
    expect(worksNotes({ module: null })).toEqual([WORKS_CARD_NOTE]);
  });

  it("the Social Media Planner adds its plan note, right after the idea pool", () => {
    expect(worksNotes({ module: "social" })).toEqual([
      WORKS_CARD_NOTE,
      WORKS_SOCIAL_PLAN_NOTE,
    ]);
    const notes = worksNotes({ ...everything, module: "social" });
    const pool = notes.findIndex((note) => note.startsWith("Idea pool"));
    expect(notes[pool + 1]).toBe(WORKS_SOCIAL_PLAN_NOTE);
    for (const key of [undefined, null, "ads", "analytics", "seo"] as const) {
      expect(worksNotes({ ...everything, module: key })).not.toContain(
        WORKS_SOCIAL_PLAN_NOTE,
      );
    }
  });

  it("the social plan note plans from the pool at once, without a goal question", () => {
    const note = WORKS_SOCIAL_PLAN_NOTE;
    // The tile's message (use-module-choice.ts SOCIAL_START_MESSAGE).
    expect(note).toContain('"Plan next week\'s posts from my idea pool."');
    expect(note).toContain("call propose_content_plan in THIS reply");
    expect(note).toContain("never ask what the plan is for");
    expect(note).toContain("never offer a wizard");
    expect(note).toContain("3 posts spread over the next 7 days");
    expect(note).toContain("the chat's default channels");
    expect(note).toContain("STRONGEST ideas of the idea pool");
    expect(note).toContain("`ideaId`");
    expect(note).toContain("only for what the pool cannot fill");
  });

  it("the social plan note sets the creative bar for every post", () => {
    const note = WORKS_SOCIAL_PLAN_NOTE;
    // A hook, never a generic opener.
    expect(note).toContain("`topic` is the hook");
    expect(note).toContain('"Discover our…"');
    // The headline on the picture, one visual idea and a caption with a CTA,
    // all in the plan tool's existing fields.
    expect(note).toContain("the on-image headline in double quotes");
    expect(note).toContain("at most 6 words");
    expect(note).toContain("the visual idea (one concrete scene");
    expect(note).toContain("ending with one clear call to action");
    expect(note).toContain("`captionIdea` is three parts");
    // The brand's voice and the post lessons.
    expect(note).toContain("the brand's language and voice");
    expect(note).toContain("what the client marked as worked");
    expect(note).toContain("never invent prices");
  });

  it("an Ads Manager, Analytics or SEO Manager chat gets the card rule without it", () => {
    for (const key of ["ads", "analytics", "seo"] as const) {
      const notes = worksNotes({ ...everything, module: key });
      // The post lessons are records, not tool guidance: they stay.
      expect(notes).toHaveLength(2);
      expect(notes[0]).toBe(WORKS_MODULE_CARD_NOTE);
      expect(notes[1]).toContain("Short captions");
      const text = notes.join("\n");
      for (const tool of POST_TOOLS) expect(text, tool).not.toContain(tool);
      expect(text).not.toContain("Idea pool");
      expect(text).not.toContain("Slots for");
      expect(text).not.toContain("Do not search the web");
    }
    expect(worksNotes({ module: "ads" })).toEqual([WORKS_MODULE_CARD_NOTE]);
  });

  it("the module card note keeps the card rule and the brand's language", () => {
    const rule = WORKS_CARD_NOTE.slice(
      0,
      WORKS_CARD_NOTE.indexOf(" This chat"),
    );
    expect(rule).toMatch(/never repeat its content in words\.$/);
    expect(WORKS_MODULE_CARD_NOTE.startsWith(rule)).toBe(true);
    expect(WORKS_MODULE_CARD_NOTE).toContain(
      "ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities.",
    );
    expect(WORKS_MODULE_CARD_NOTE).toContain("never promise a day or time");
    expect(WORKS_MODULE_CARD_NOTE).toContain("the brand's rules and language");
  });
});

describe("hidden-tools-note", () => {
  it("names the hidden tools as unavailable and the replacements", () => {
    for (const tool of WORKS_HIDDEN_TOOLS)
      expect(WORKS_CARD_NOTE).toContain(tool);
    expect(WORKS_CARD_NOTE).toContain(
      "ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities",
    );
    for (const name of ["propose_plan_options", "propose_ideas"]) {
      expect(WORKS_CARD_NOTE).toContain(name);
    }
  });

  it("tells the model not to web-search and routes typed changes", () => {
    expect(WORKS_CARD_NOTE).toContain(
      "Do not search the web for plans or ideas",
    );
    // A plan request goes straight to a plan: no wizard, no directions first.
    expect(WORKS_CARD_NOTE).toContain("call propose_content_plan RIGHT AWAY");
    expect(WORKS_CARD_NOTE).toContain(
      "no wizard, no questions, no directions first",
    );
    expect(WORKS_CARD_NOTE).toContain("again with the full updated plan");
    expect(WORKS_CARD_NOTE).toContain("never ask which channel it is for");
  });

  it("worksSkill strips every hidden tool and keeps the lines", () => {
    const before = JSON.stringify(SKILLS);
    for (const key of SKILL_KEYS) {
      const original = SKILLS[key];
      const works = worksSkill(original);
      for (const tool of WORKS_HIDDEN_TOOLS) {
        expect(works.instructions).not.toContain(tool);
        expect(works.tools).not.toContain(tool);
      }
      expect(works.instructions.split("\n")).toHaveLength(
        original.instructions.split("\n").length,
      );
      works.instructions.split("\n").forEach((line, i) => {
        expect(line.startsWith(`${i + 1}. `)).toBe(true);
      });
    }
    expect(JSON.stringify(SKILLS)).toBe(before);
  });

  it("no skill points at the removed package or the old wizard hand-off in a Work", () => {
    for (const key of SKILL_KEYS) {
      const works = worksSkill(SKILLS[key]).instructions;
      // "there is no content package" is the replacement sentence itself.
      expect(works, key).not.toMatch(/(?<!no )content package/);
      expect(works, key).not.toContain(
        "start_plan_brief, then propose_content_plan",
      );
    }
    // ... and the registry itself is not touched (not vacuous: the old text exists).
    const original = SKILL_KEYS.map((key) => SKILLS[key].instructions).join(
      "\n",
    );
    expect(original).toContain("content package");
    expect(original).toContain("start_plan_brief, then propose_content_plan");
    expect(worksSkill(SKILLS.content).instructions).toContain(
      "start_plan_brief, then propose_plan_options when the [Plan brief] arrives",
    );
  });

  it("routes one message for several channels to propose_master_content", () => {
    expect(WORKS_CARD_NOTE).toContain("call propose_master_content");
    expect(WORKS_CARD_NOTE).toContain("never create_task once per channel");
  });

  it("tells the model a Work picture is a Post or a Story only", () => {
    expect(WORKS_CARD_NOTE).toContain(
      "never offer or ask for a Reel or a square picture",
    );
  });

  it("replaces a hidden-tool sentence once and keeps the others", () => {
    const works = worksSkill(SKILLS.creative);
    const line = works.instructions.split("\n")[5];
    expect(line).toBe(
      `6. One visual per message. ${WORKS_PACKAGE_REPLACEMENT}`,
    );
    const untouched = worksSkill(SKILLS.research);
    expect(untouched.instructions).toBe(SKILLS.research.instructions);
  });
});
