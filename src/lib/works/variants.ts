import type { NextStep } from "@/lib/journey";

// The creative-variant numbers (spec 3.10.1). Nothing asks for new variants
// any more (one post, one picture); a variants job already in flight still
// reads them (the image provider, execution-service.ts), and pieces keep the
// alternatives they were given.
export const VARIANT_COUNT = 3;
export const VARIANT_QUALITY = "medium" as const;
// Two sets: 1 current picture + 5 alternatives = 6 pictures per piece.
const MAX_VARIANT_ALTERNATIVES = 5;

export function remainingVariantSlots(alternativesCount: number): number {
  return Math.max(0, MAX_VARIANT_ALTERNATIVES - Math.max(0, alternativesCount));
}

export type CreativeAlternative = {
  assetId: string;
  label?: string;
  assetWidth?: number;
  assetHeight?: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Defensive reader of generationMetadata.alternatives: skips malformed entries.
export function parseAlternatives(metadata: unknown): CreativeAlternative[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.alternatives)) return [];
  const out: CreativeAlternative[] = [];
  for (const raw of metadata.alternatives) {
    if (!isRecord(raw)) continue;
    if (typeof raw.assetId !== "string" || !raw.assetId) continue;
    const alt: CreativeAlternative = { assetId: raw.assetId };
    if (typeof raw.label === "string") alt.label = raw.label;
    if (typeof raw.assetWidth === "number" && Number.isFinite(raw.assetWidth)) {
      alt.assetWidth = raw.assetWidth;
    }
    if (
      typeof raw.assetHeight === "number" &&
      Number.isFinite(raw.assetHeight)
    ) {
      alt.assetHeight = raw.assetHeight;
    }
    out.push(alt);
  }
  return out;
}

// A bulk "Approve n" must not lock the current picture of a piece that still
// has unchosen alternatives: those stay reviewable one by one.
export function excludeVariantPieces(
  steps: readonly NextStep[],
  creativeIdsWithAlternatives: ReadonlySet<string>,
): NextStep[] {
  const out: NextStep[] = [];
  for (const step of steps) {
    if (step.action.kind !== "approve_plan") {
      out.push(step);
      continue;
    }
    const creativeIds = step.action.creativeIds.filter(
      (id) => !creativeIdsWithAlternatives.has(id),
    );
    if (creativeIds.length < 2) continue;
    if (creativeIds.length === step.action.creativeIds.length) {
      out.push(step);
      continue;
    }
    const count = creativeIds.length;
    out.push({
      ...step,
      label: step.label.replace(/\d+/, String(count)),
      title: step.title.replace(/\d+/, String(count)),
      action: { ...step.action, creativeIds, count },
    });
  }
  return out;
}
