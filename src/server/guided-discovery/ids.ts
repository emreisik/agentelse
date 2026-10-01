import "server-only";

import { createHash } from "node:crypto";

import type { FieldId } from "@/lib/guided-discovery/contract";

// Server-made candidate id: stable across runs (a re-run maps the same value to
// the same id) and never derived from anything a client sends.
export function candidateIdFor(
  projectId: string,
  field: FieldId | string,
  text: string,
): string {
  const folded = text.trim().toLowerCase();
  const digest = createHash("sha256")
    .update(`${projectId}\u0000${field}\u0000${folded}`)
    .digest("hex");
  return `c_${digest.slice(0, 10)}`;
}
