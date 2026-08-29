import { z } from "zod";

import { StrategyOutputSchema } from "@/server/reasoning/prompts/strategy-synthesis";

// The persisted BrandStrategyVersion.payload contract. Currently a direct
// pass-through of the reasoning output — kept as its own module (rather than
// inlining the reasoning schema) so callers depend on the persistence
// contract, not the reasoning one, mirroring constitution-schema.ts.
export const BrandStrategyPayloadSchema = StrategyOutputSchema;

export type BrandStrategyPayload = z.infer<typeof BrandStrategyPayloadSchema>;

export function parseStrategyPayload(payload: unknown): BrandStrategyPayload {
  return BrandStrategyPayloadSchema.parse(payload);
}
