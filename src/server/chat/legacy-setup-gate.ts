// The legacy ChatService gates its onboarding on `setupPhase`, which is derived
// from the existence of a ProjectSetupState row. Guided setup never creates one
// (that row is the paid 12-stage worker), so without this resolver a project
// that just finished the sheet would be interviewed again. Pure, flag-gated and
// deletable together with the legacy ChatService: flag off is today's value.
export type LegacySetupPhase = "NOT_STARTED" | "IN_PROGRESS" | "ACTIVE";

export type SetupRowLite = {
  activatedAt: Date | null;
  // ProjectSetupState.intake.mode ("ENRICHMENT" | "FULL" | absent).
  mode?: string | null;
} | null;

// Today's derivation (context.ts), unchanged.
export function rawLegacyPhase(row: SetupRowLite): LegacySetupPhase {
  if (!row) return "NOT_STARTED";
  return row.activatedAt ? "ACTIVE" : "IN_PROGRESS";
}

export type GateInput = {
  // GUIDED_SETUP, read once at the edge (command-actions.ts).
  enabled: boolean;
  row: SetupRowLite;
  // context.brand.confidence === "high": an ACTIVE, non-mock constitution.
  profileReady: boolean;
  // The guided session was applied (one primary-key read, only when needed).
  guidedApplied: boolean;
};

// True when the answer depends on guidedApplied, so the caller reads the
// session row only then (no extra query on any other turn).
export function needsGuidedAppliedLookup(
  input: Omit<GateInput, "guidedApplied">,
): boolean {
  return (
    input.enabled &&
    rawLegacyPhase(input.row) === "NOT_STARTED" &&
    !input.profileReady
  );
}

export function resolveLegacySetupPhase(input: GateInput): LegacySetupPhase {
  const raw = rawLegacyPhase(input.row);
  if (!input.enabled) return raw;
  // A deep-research run (ENRICHMENT) never blocks work, the same rule as the
  // agent engine ("it does not block any work"). A FULL run still does.
  if (raw === "IN_PROGRESS" && input.row?.mode === "ENRICHMENT") {
    return "ACTIVE";
  }
  if (raw === "NOT_STARTED" && (input.profileReady || input.guidedApplied)) {
    return "ACTIVE";
  }
  return raw;
}
