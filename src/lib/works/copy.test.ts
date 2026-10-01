import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKS_COPY, brandCheckText, copyText, type CopyKey } from "./copy";

const KEYS = Object.keys(WORKS_COPY) as CopyKey[];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] ?? "");
}

describe("WORKS_COPY", () => {
  it("has non-empty values without edge spaces", () => {
    expect(KEYS.length).toBeGreaterThan(200);
    for (const key of KEYS) {
      const v: string = WORKS_COPY[key];
      expect(v, key).not.toBe("");
      expect(v, key).toBe(v.trim());
    }
  });

  it("does not duplicate slice-1 pinned keys", () => {
    expect(KEYS).not.toContain("workHeader.working" as CopyKey);
  });

  it("substitutes placeholders and leaves unknown ones", () => {
    expect(copyText("publish.review.scheduled", { when: "Mon 9:00" })).toBe(
      "If you approve, it goes out on or after Mon 9:00.",
    );
    expect(copyText("publish.review.scheduled")).toContain("{when}");
    expect(copyText("publish.review.scheduled", { other: 1 })).toContain(
      "{when}",
    );
    expect(copyText("kit.tryAgain", { n: 3 })).toBe("Try again");
  });

  it("numbers are stringified, including 0", () => {
    const key = KEYS.find((k) => placeholders(WORKS_COPY[k]).includes("n"));
    expect(key).toBeDefined();
    expect(copyText(key as CopyKey, { n: 0 })).not.toContain("{n}");
  });

  it("brandCheckText tells a zero-rule check from a failed load", () => {
    expect(brandCheckText({ state: "checked", rules: 3 })).toBe(
      "Checked against 3 brand rules.",
    );
    expect(brandCheckText({ state: "checked", rules: 0 })).toBe(
      copyText("brand.checkedNone"),
    );
    expect(brandCheckText({ state: "skipped" })).toBe(
      copyText("brand.unavailable"),
    );
  });

  it("leaves no brace behind when every placeholder is filled", () => {
    for (const key of KEYS) {
      const names = placeholders(WORKS_COPY[key]);
      if (names.length === 0) continue;
      const values = Object.fromEntries(names.map((n) => [n, "x"]));
      expect(copyText(key, values), key).not.toContain("{");
    }
  });
});

// COPY-COVERAGE SCAN (guard W01). Wave-2 files that do not exist yet are skipped.
const NEW_COMPONENT_FILES = [
  "action-card.tsx",
  "card-actions.tsx",
  "plan-options-card.tsx",
  "idea-options-card.tsx",
  "plan-card-extras.tsx",
  "planned-slot-card.tsx",
  "creative-publish-line.tsx",
  "works-card.tsx",
  "slot-suggestion.tsx",
  "live-region.tsx",
  "work-card-host.tsx",
  "pending-card.tsx",
  "work-return-link.tsx",
  "master-content-card.tsx",
  "creative-variants-strip.tsx",
  "daily-brief-card.tsx",
  "ads-insight-card.tsx",
  "channel-offer-banner.tsx",
  // Slice-1 files with their own *_COPY constants (channel-select-card,
  // starter-cards, work-header, channel-picker, new-work-opener) are not
  // scanned: their pinned English baseline predates the copy table.
  "work-start.tsx",
  "card-focus.tsx",
].map((f) => join("src/components/works", f));

// Literals that are not user-visible sentences. One comment per entry.
const ALLOWED_LITERALS = new Set<string>([
  // Module specifiers and directives are code, not copy.
  "Use client",
  // The three one-tap "tweak" chips under the plan directions send these as the
  // person's own turn: instructions to the agent, not interface text (the chip
  // labels are the copy keys planOptions.tweak.*).
  "Make the directions more playful.",
  "Make the directions more educational.",
  "Make the directions shorter and simpler.",
]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** Returns string literals and JSX text nodes that look like hard-coded sentences. */
function findHardCodedSentences(source: string): string[] {
  const src = stripComments(source);
  const found: string[] = [];
  const sentence = (t: string) => {
    const s = t.trim();
    return (
      /^[A-Z]/.test(s) && s.split(/\s+/).length >= 2 && !ALLOWED_LITERALS.has(s)
    );
  };
  for (const m of src.matchAll(
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
  )) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    if (sentence(text)) found.push(text.trim());
  }
  // JSX text: between a closing ">" and the next "<" or "{", with a word char run.
  for (const m of src.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)(?=[<{])/g)) {
    const text = (m[1] ?? "").replace(/\s+/g, " ");
    if (/^\s*$/.test(text)) continue;
    if (sentence(text)) found.push(text.trim());
  }
  return found;
}

describe("copy coverage scan (W01)", () => {
  it("flags hard-coded sentences in strings and JSX text", () => {
    expect(
      findHardCodedSentences('const a = "Nothing to show here";'),
    ).toHaveLength(1);
    expect(findHardCodedSentences("<p>Nothing to show here</p>")).toHaveLength(
      1,
    );
    expect(
      findHardCodedSentences(
        '<p className="mt-2 text-sm">{copyText("kit.tryAgain")}</p>',
      ),
    ).toEqual([]);
    expect(
      findHardCodedSentences('// Nothing to show here\nconst a = "ok";'),
    ).toEqual([]);
    expect(findHardCodedSentences('const a = "kit.tryAgain";')).toEqual([]);
  });

  for (const file of NEW_COMPONENT_FILES) {
    it(`${file} has no hard-coded sentence`, () => {
      if (!existsSync(file)) return;
      expect(findHardCodedSentences(readFileSync(file, "utf8")), file).toEqual(
        [],
      );
    });
  }
});
