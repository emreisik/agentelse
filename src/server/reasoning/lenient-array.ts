import { z } from "zod";

// A lenient array: an item that fails validation (a malformed object, a bad
// enum, a missing required field — the same category of thing providers'
// structured-output modes don't reliably enforce, see score-schema.ts) is
// dropped instead of failing the WHOLE array. As an array grows (e.g. one
// recommendation per department across ~19 departments), the odds that at
// least one item is malformed rise with it — losing 18 good recommendations
// to one bad one is a worse failure than a shorter-than-requested list.
export function zLenientArray<T extends z.ZodType>(itemSchema: T) {
  return z
    .array(itemSchema.catch(undefined as never))
    .transform((items) =>
      items.filter((item): item is z.infer<T> => item !== undefined),
    );
}
