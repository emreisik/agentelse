import { classifyArchetype, type Archetype } from "@/lib/auto-layout";

// Reads what a brand says about itself out of a brand context (the execution
// snapshot, or the same shape built from the database) and names the design its
// posts follow when nobody picked one (a pick per format is applied on top, in
// planCreativeLayout). Defensive: the context is loosely typed Json.

function collect(value: unknown, into: string[], depth = 0): void {
  if (depth > 3 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.trim()) into.push(value.trim().slice(0, 400));
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) collect(item, into, depth + 1);
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "label", "title", "description"]) {
      collect(record[key], into, depth + 1);
    }
  }
}

export function archetypeOfBrandContext(context: unknown): Archetype {
  if (!context || typeof context !== "object") return "editorial";
  const ctx = context as Record<string, unknown>;

  const parts: string[] = [];

  collect(ctx.positioning, parts);
  collect(ctx.summary, parts);
  collect(ctx.products, parts);
  collect(ctx.services, parts);

  // The synthesized constitution carries the business in its own words.
  const constitution = ctx.brandConstitution as
    | { summary?: unknown; payload?: unknown }
    | null
    | undefined;
  if (constitution) {
    collect(constitution.summary, parts);
    const payload = (constitution.payload ?? {}) as Record<string, unknown>;
    for (const key of ["identity", "businessModel", "products", "positioning"]) {
      collect(payload[key], parts);
    }
  }
  // A context read straight from the constitution payload.
  for (const key of ["identity", "businessModel"]) collect(ctx[key], parts);

  const identity = ctx.visualIdentity as { moodTags?: unknown } | null | undefined;
  const moodTags = Array.isArray(identity?.moodTags)
    ? (identity.moodTags as unknown[]).filter(
        (tag): tag is string => typeof tag === "string",
      )
    : [];

  return classifyArchetype({ text: parts.join(" "), moodTags });
}
