import type { EntityKind } from "../../hub-core-params";

// Which part of the Intelligence tab is open, and whether there is anything to
// show at all. Pure so the tab's decisions are testable without the database.

export const INTELLIGENCE_SECTIONS = [
  "findings",
  "insights",
  "opportunities",
  "signals",
] as const;
export type IntelligenceSection = (typeof INTELLIGENCE_SECTIONS)[number];

export type IntelligenceCounts = Record<IntelligenceSection, number>;

export function intelligenceTotal(counts: IntelligenceCounts): number {
  return INTELLIGENCE_SECTIONS.reduce((sum, key) => sum + counts[key], 0);
}

// Nothing gathered yet: a new project before the agent has researched anything
// and with no Meta Ads / Google Analytics connected.
export function intelligenceIsEmpty(counts: IntelligenceCounts): boolean {
  return intelligenceTotal(counts) === 0;
}

// The section a record (a cross-link, a deep link) belongs to.
export function sectionOfEntity(kind: EntityKind): IntelligenceSection | null {
  switch (kind) {
    case "finding":
      return "findings";
    case "insight":
      return "insights";
    case "opportunity":
      return "opportunities";
    case "signal":
      return "signals";
    default:
      return null;
  }
}

// The one section that starts open: the first that has anything, in the order
// the derivation runs downstream (what we found, what it means, what to do,
// the raw signals). null when there is nothing.
export function sectionOpenedFirst(
  counts: IntelligenceCounts,
): IntelligenceSection | null {
  return INTELLIGENCE_SECTIONS.find((key) => counts[key] > 0) ?? null;
}
