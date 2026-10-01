// Where a calendar slot came from. The origin key makes "Add to calendar"
// idempotent without a Creative-to-idea link (spec 3.4.2).

export const SLOT_ORIGIN_KINDS = ["idea", "master", "brief", "creative"] as const;

export type SlotOriginKind = (typeof SLOT_ORIGIN_KINDS)[number];

export type SlotOrigin = { kind: SlotOriginKind; ref: string };

const MAX_REF_LENGTH = 64;

export function slotOriginKey(
  origin: SlotOrigin,
  channel: string,
  formatKey: string,
): string {
  return `${origin.kind}:${origin.ref}:${channel}:${formatKey}`;
}

// Strict on purpose: origins are read back from stored card JSON.
export function isSlotOrigin(value: unknown): value is SlotOrigin {
  if (typeof value !== "object" || value === null) return false;
  const { kind, ref } = value as Record<string, unknown>;
  return (
    typeof kind === "string" &&
    (SLOT_ORIGIN_KINDS as readonly string[]).includes(kind) &&
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= MAX_REF_LENGTH
  );
}
