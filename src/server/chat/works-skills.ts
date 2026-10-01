import { type Skill } from "./skills/registry";

// In a Work two tools are hidden from the model, but the skills (load_skill)
// still name them. worksSkill() returns a copy that does not.

export const WORKS_HIDDEN_TOOLS = [
  "propose_content_package",
  "generate_ideas_from_opportunities",
] as const;

export const WORKS_PACKAGE_REPLACEMENT =
  "In a Work there is no content package: for several pieces around a topic use propose_plan_options (it needs a [Plan brief]) or propose_ideas; for one piece use generate_image or create_task (the piece goes on the calendar first).";

function mentionsHiddenTool(text: string): boolean {
  return WORKS_HIDDEN_TOOLS.some((tool) => text.includes(tool));
}

function stripTrailingDot(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

// One numbered line: keep the "n. " prefix, process the rest sentence by
// sentence. The replacement is written once; later hidden-tool sentences of
// the same line are dropped so it is not repeated.
function worksLine(line: string): string {
  if (!mentionsHiddenTool(line)) return line;
  const prefix = /^\d+\. /.exec(line)?.[0] ?? "";
  const body = line.slice(prefix.length);
  const kept: string[] = [];
  let replaced = false;
  for (const sentence of body.split(". ")) {
    if (!mentionsHiddenTool(sentence)) {
      kept.push(stripTrailingDot(sentence));
    } else if (!replaced) {
      replaced = true;
      kept.push(stripTrailingDot(WORKS_PACKAGE_REPLACEMENT));
    }
  }
  return `${prefix}${kept.join(". ")}.`;
}

// Wording that points at the removed flows without naming a hidden tool: the
// package as a place to put a deliverable, and the wizard hand-off, which in a
// Work ends in the directions card instead of propose_content_plan.
const WORKS_REWRITES: readonly (readonly [RegExp, string])[] = [
  [
    /start_plan_brief, then propose_content_plan/g,
    "start_plan_brief, then propose_plan_options when the [Plan brief] arrives",
  ],
  [/the ad_copy deliverable in a content package, or /g, ""],
  [
    /Use the seo_article deliverable in a content package for it\./g,
    "Use create_task for it.",
  ],
];

function worksWording(line: string): string {
  return WORKS_REWRITES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    line,
  );
}

export function worksSkill(skill: Skill): Skill {
  const hidden: readonly string[] = WORKS_HIDDEN_TOOLS;
  return {
    ...skill,
    tools: skill.tools.filter((tool) => !hidden.includes(tool)),
    instructions: skill.instructions
      .split("\n")
      .map((line) => worksWording(worksLine(line)))
      .join("\n"),
  };
}
