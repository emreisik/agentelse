import { z } from "zod";

import { ConstitutionOutputSchema } from "@/server/reasoning/prompts/constitution-synthesis";

// The persisted BrandConstitution.payload contract. Wraps the reasoning
// output with logo assets (which come from intake, not from reasoning).
export const BrandConstitutionPayloadSchema = ConstitutionOutputSchema.extend({
  logoAssetIds: z.array(z.string()).default([]),
});

export type BrandConstitutionPayload = z.infer<
  typeof BrandConstitutionPayloadSchema
>;

export function parseConstitutionPayload(
  payload: unknown,
): BrandConstitutionPayload {
  return BrandConstitutionPayloadSchema.parse(payload);
}
