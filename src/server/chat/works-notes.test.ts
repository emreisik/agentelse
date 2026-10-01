import { describe, expect, it } from "vitest";

import { MAX_OPTION_SLOTS } from "@/lib/works/plan-layout";

import { SKILL_KEYS, SKILLS } from "./skills/registry";
import {
  WORKS_CARD_NOTE,
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
      worksPlanSlotsNote(["Mon 5 Oct 10:00 · instagram.post", "Wed 7 Oct 10:00 · linkedin.post"], 2),
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
    expect(WORKS_TOO_LARGE_NOTE).toContain(`more than ${MAX_OPTION_SLOTS} posts`);
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
    expect(slotsNote).toContain(`Each option needs exactly ${MAX_OPTION_SLOTS} ideas`);
    expect((notes[0] ?? "").length).toBeLessThan(2500);
  });
});

describe("hidden-tools-note", () => {
  it("names the hidden tools as unavailable and the replacements", () => {
    for (const tool of WORKS_HIDDEN_TOOLS) expect(WORKS_CARD_NOTE).toContain(tool);
    expect(WORKS_CARD_NOTE).toContain(
      "ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities",
    );
    for (const name of ["propose_plan_options", "propose_ideas", "start_plan_brief"]) {
      expect(WORKS_CARD_NOTE).toContain(name);
    }
  });

  it("tells the model not to web-search and routes typed changes", () => {
    expect(WORKS_CARD_NOTE).toContain("Do not search the web for plans or ideas");
    expect(WORKS_CARD_NOTE).toContain("change the DIRECTIONS");
    expect(WORKS_CARD_NOTE).toContain("to change the plan they already picked");
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
      expect(works, key).not.toContain("start_plan_brief, then propose_content_plan");
    }
    // ... and the registry itself is not touched (not vacuous: the old text exists).
    const original = SKILL_KEYS.map((key) => SKILLS[key].instructions).join("\n");
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
    expect(WORKS_CARD_NOTE).toContain("never offer or ask for a Reel or a square picture");
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
