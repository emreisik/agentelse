import { z } from "zod";

// A lenient array: an item that fails validation (a malformed object, a bad
// enum, a missing required field — the same category of thing providers'
// structured-output modes don't reliably enforce, see score-schema.ts) is
// dropped instead of failing the WHOLE array. As an array grows (e.g. one
// recommendation per department across ~19 departments), the odds that at
// least one item is malformed rise with it — losing 18 good recommendations
// to one bad one is a worse failure than a shorter-than-requested list.
//
// The trailing .pipe(z.array(itemSchema)) is required, not decorative: a
// bare .transform() has no declared output type, and reasoning-service.ts
// passes `z.toJSONSchema(def.schema)` to the provider on every REAL call —
// z.toJSONSchema() throws "Transforms cannot be represented in JSON Schema"
// on a bare transform. Every def using this helper (constitution-synthesis,
// research-extraction, department-recommendation, signal-profile-
// recommendation, instagram-style) was silently failing every real call
// with that exact error until this was added — the .pipe() re-validates the
// already-filtered items against itemSchema (a no-op, since they already
// passed it) purely to give toJSONSchema a representable output shape.
//
// The cast on outputArraySchema below is safe, not a type-safety hole: it
// only asserts that z.array(itemSchema)'s INPUT type is its own OUTPUT type
// (true for any plain, non-further-transformed schema) — something Zod's
// generic .pipe() signature can't prove for an unconstrained `T extends
// z.ZodType`, but that holds for every real caller of this function.
export function zLenientArray<T extends z.ZodType>(
  itemSchema: T,
): z.ZodType<z.output<T>[]> {
  const outputArraySchema = z.array(itemSchema) as unknown as z.ZodType<
    z.output<T>[],
    z.output<T>[]
  >;
  return z
    .array(itemSchema.catch(undefined as never))
    .transform((items) =>
      items.filter((item): item is z.output<T> => item !== undefined),
    )
    .pipe(outputArraySchema);
}
