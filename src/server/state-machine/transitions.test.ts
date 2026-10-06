import { describe, expect, it } from "vitest";

import { StateMachine } from "@/server/state-machine/transitions";
import { AgentelseError } from "@/server/security/errors";

describe("StateMachine — Task transitions", () => {
  it("allows the normal happy path", () => {
    expect(() =>
      StateMachine.assertTaskTransition("DRAFT", "READY"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertTaskTransition("READY", "QUEUED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertTaskTransition("QUEUED", "RUNNING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertTaskTransition("RUNNING", "COMPLETED"),
    ).not.toThrow();
  });

  it("allows READY -> WAITING_APPROVAL (approval-gated capabilities)", () => {
    expect(() =>
      StateMachine.assertTaskTransition("READY", "WAITING_APPROVAL"),
    ).not.toThrow();
  });

  it("rejects COMPLETED -> RUNNING", () => {
    expect(() =>
      StateMachine.assertTaskTransition("COMPLETED", "RUNNING"),
    ).toThrow(AgentelseError);
  });

  it("rejects skipping straight from DRAFT to COMPLETED", () => {
    expect(() =>
      StateMachine.assertTaskTransition("DRAFT", "COMPLETED"),
    ).toThrow(AgentelseError);
  });

  it("is a no-op for identical from/to", () => {
    expect(() =>
      StateMachine.assertTaskTransition("COMPLETED", "COMPLETED"),
    ).not.toThrow();
  });
});

describe("StateMachine — ExecutionJob transitions", () => {
  it("allows QUEUED -> RUNNING -> WAITING_HUMAN -> RUNNING -> VERIFYING -> COMPLETED", () => {
    expect(() =>
      StateMachine.assertExecutionJobTransition("QUEUED", "RUNNING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertExecutionJobTransition("RUNNING", "WAITING_HUMAN"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertExecutionJobTransition("WAITING_HUMAN", "RUNNING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertExecutionJobTransition("RUNNING", "VERIFYING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertExecutionJobTransition("VERIFYING", "COMPLETED"),
    ).not.toThrow();
  });

  it("rejects COMPLETED -> anything", () => {
    expect(() =>
      StateMachine.assertExecutionJobTransition("COMPLETED", "RUNNING"),
    ).toThrow(AgentelseError);
    expect(() =>
      StateMachine.assertExecutionJobTransition("COMPLETED", "FAILED"),
    ).toThrow(AgentelseError);
  });

  it("allows FAILED -> QUEUED (manual retry)", () => {
    expect(() =>
      StateMachine.assertExecutionJobTransition("FAILED", "QUEUED"),
    ).not.toThrow();
  });
});

describe("StateMachine — Approval transitions", () => {
  it("allows PENDING -> APPROVED/REJECTED/REVISION_REQUESTED", () => {
    expect(() =>
      StateMachine.assertApprovalTransition("PENDING", "APPROVED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertApprovalTransition("PENDING", "REJECTED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertApprovalTransition("PENDING", "REVISION_REQUESTED"),
    ).not.toThrow();
  });

  it("rejects re-deciding an already-approved approval", () => {
    expect(() =>
      StateMachine.assertApprovalTransition("APPROVED", "REJECTED"),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — Creative transitions", () => {
  it("supports the CREATE -> REVIEW -> APPROVE -> PUBLISH pipeline", () => {
    expect(() =>
      StateMachine.assertCreativeTransition("DRAFT", "IN_REVIEW"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertCreativeTransition("IN_REVIEW", "APPROVED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertCreativeTransition("APPROVED", "PUBLISHED"),
    ).not.toThrow();
  });

  it("rejects publishing a rejected creative directly", () => {
    expect(() =>
      StateMachine.assertCreativeTransition("REJECTED", "PUBLISHED"),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — Project transitions (setup wizard)", () => {
  it("supports the CREATED -> DISCOVERY -> PROFILE_REVIEW -> ACTIVE happy path", () => {
    expect(() =>
      StateMachine.assertProjectTransition("CREATED", "DISCOVERY"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectTransition("DISCOVERY", "PROFILE_REVIEW"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectTransition("PROFILE_REVIEW", "ACTIVE"),
    ).not.toThrow();
  });

  it("supports the manual-fallback path via NEEDS_INFORMATION", () => {
    expect(() =>
      StateMachine.assertProjectTransition("DISCOVERY", "NEEDS_INFORMATION"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectTransition(
        "NEEDS_INFORMATION",
        "PROFILE_REVIEW",
      ),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectTransition("NEEDS_INFORMATION", "DISCOVERY"),
    ).not.toThrow();
  });

  it("rejects skipping straight from CREATED to ACTIVE", () => {
    expect(() =>
      StateMachine.assertProjectTransition("CREATED", "ACTIVE"),
    ).toThrow(AgentelseError);
  });

  it("rejects re-activating a closed project", () => {
    expect(() =>
      StateMachine.assertProjectTransition("CLOSED", "ACTIVE"),
    ).toThrow(AgentelseError);
  });
});

// =============================================================================
// AGENCY OS LIFECYCLES
// =============================================================================

describe("StateMachine — SetupStageRecord transitions", () => {
  it("supports PENDING -> RUNNING -> COMPLETED", () => {
    expect(() =>
      StateMachine.assertSetupStageTransition("PENDING", "RUNNING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertSetupStageTransition("RUNNING", "COMPLETED"),
    ).not.toThrow();
  });

  it("supports the client-gated path RUNNING -> WAITING_CLIENT -> COMPLETED", () => {
    expect(() =>
      StateMachine.assertSetupStageTransition("RUNNING", "WAITING_CLIENT"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertSetupStageTransition("WAITING_CLIENT", "COMPLETED"),
    ).not.toThrow();
  });

  it("allows retrying a FAILED stage", () => {
    expect(() =>
      StateMachine.assertSetupStageTransition("FAILED", "RUNNING"),
    ).not.toThrow();
  });

  it("rejects reopening a COMPLETED stage", () => {
    expect(() =>
      StateMachine.assertSetupStageTransition("COMPLETED", "RUNNING"),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — Signal transitions", () => {
  it("supports NEW -> SCORED -> PROMOTED", () => {
    expect(() =>
      StateMachine.assertSignalTransition("NEW", "SCORED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertSignalTransition("SCORED", "PROMOTED"),
    ).not.toThrow();
  });

  it("allows NEW -> DUPLICATE short-circuit", () => {
    expect(() =>
      StateMachine.assertSignalTransition("NEW", "DUPLICATE"),
    ).not.toThrow();
  });

  it("rejects resurrecting a DISCARDED signal", () => {
    expect(() =>
      StateMachine.assertSignalTransition("DISCARDED", "SCORED"),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — Opportunity transitions", () => {
  it("supports NEW -> EVALUATED -> ACCEPTED -> CONVERTED_TO_IDEA", () => {
    expect(() =>
      StateMachine.assertOpportunityTransition("NEW", "EVALUATED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertOpportunityTransition("EVALUATED", "ACCEPTED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertOpportunityTransition("ACCEPTED", "CONVERTED_TO_IDEA"),
    ).not.toThrow();
  });

  it("keeps the legacy dashboard path NEW -> REVIEWING -> ACCEPTED working", () => {
    expect(() =>
      StateMachine.assertOpportunityTransition("NEW", "REVIEWING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertOpportunityTransition("REVIEWING", "ACCEPTED"),
    ).not.toThrow();
  });

  it("rejects converting a DISMISSED opportunity", () => {
    expect(() =>
      StateMachine.assertOpportunityTransition(
        "DISMISSED",
        "CONVERTED_TO_TASK",
      ),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — Idea lifecycle", () => {
  it("supports the full RAW -> ... -> LEARNED walk", () => {
    const walk = [
      ["RAW", "VALIDATED"],
      ["VALIDATED", "CONCEPT"],
      ["CONCEPT", "SHORTLISTED"],
      ["SHORTLISTED", "APPROVED"],
      ["APPROVED", "PLANNING"],
      ["PLANNING", "ACTIVE"],
      ["ACTIVE", "MEASURING"],
      ["MEASURING", "LEARNED"],
      ["LEARNED", "ARCHIVED"],
    ] as const;
    for (const [from, to] of walk) {
      expect(() => StateMachine.assertIdeaTransition(from, to)).not.toThrow();
    }
  });

  it("allows the council to REJECT at every pre-approval stage", () => {
    for (const from of [
      "RAW",
      "RESEARCHING",
      "VALIDATED",
      "CONCEPT",
      "SHORTLISTED",
    ] as const) {
      expect(() =>
        StateMachine.assertIdeaTransition(from, "REJECTED"),
      ).not.toThrow();
    }
  });

  it("rejects skipping from RAW straight to APPROVED", () => {
    expect(() => StateMachine.assertIdeaTransition("RAW", "APPROVED")).toThrow(
      AgentelseError,
    );
  });

  it("rejects reviving a REJECTED idea", () => {
    expect(() => StateMachine.assertIdeaTransition("REJECTED", "RAW")).toThrow(
      AgentelseError,
    );
  });

  it("saves a typed idea straight from VALIDATED, never through SHORTLISTED", () => {
    expect(() =>
      StateMachine.assertIdeaTransition("VALIDATED", "APPROVED"),
    ).not.toThrow();
  });

  it("lets the Ideas board unsave, archive or turn down a saved idea", () => {
    for (const to of [
      "VALIDATED",
      "SHORTLISTED",
      "ARCHIVED",
      "REJECTED",
    ] as const) {
      expect(() =>
        StateMachine.assertIdeaTransition("APPROVED", to),
      ).not.toThrow();
    }
  });
});

describe("StateMachine — WorkPlan / WorkHandoff transitions", () => {
  it("supports DRAFT -> AWAITING_APPROVAL -> APPROVED -> IN_PROGRESS -> COMPLETED", () => {
    expect(() =>
      StateMachine.assertWorkPlanTransition("DRAFT", "AWAITING_APPROVAL"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertWorkPlanTransition("AWAITING_APPROVAL", "APPROVED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertWorkPlanTransition("APPROVED", "IN_PROGRESS"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertWorkPlanTransition("IN_PROGRESS", "COMPLETED"),
    ).not.toThrow();
  });

  it("supports handoff walk PROPOSED -> ACCEPTED -> TASK_CREATED -> COMPLETED", () => {
    expect(() =>
      StateMachine.assertWorkHandoffTransition("PROPOSED", "ACCEPTED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertWorkHandoffTransition("ACCEPTED", "TASK_CREATED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertWorkHandoffTransition("TASK_CREATED", "COMPLETED"),
    ).not.toThrow();
  });

  it("rejects creating a task from a REJECTED handoff", () => {
    expect(() =>
      StateMachine.assertWorkHandoffTransition("REJECTED", "TASK_CREATED"),
    ).toThrow(AgentelseError);
  });
});

describe("StateMachine — ProjectGoal / MeasurementCheck / AgencyTrigger", () => {
  it("supports PROPOSED -> APPROVED -> ACTIVE -> ACHIEVED goals", () => {
    expect(() =>
      StateMachine.assertProjectGoalTransition("PROPOSED", "APPROVED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectGoalTransition("APPROVED", "ACTIVE"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertProjectGoalTransition("ACTIVE", "ACHIEVED"),
    ).not.toThrow();
  });

  it("supports measurement PENDING -> SCHEDULED -> RUNNING -> COMPLETED and FAILED retry", () => {
    expect(() =>
      StateMachine.assertMeasurementCheckTransition("PENDING", "SCHEDULED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertMeasurementCheckTransition("SCHEDULED", "RUNNING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertMeasurementCheckTransition("RUNNING", "COMPLETED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertMeasurementCheckTransition("FAILED", "SCHEDULED"),
    ).not.toThrow();
  });

  it("supports trigger PENDING -> PROCESSING -> PROCESSED and FAILED -> PENDING retry", () => {
    expect(() =>
      StateMachine.assertAgencyTriggerTransition("PENDING", "PROCESSING"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertAgencyTriggerTransition("PROCESSING", "PROCESSED"),
    ).not.toThrow();
    expect(() =>
      StateMachine.assertAgencyTriggerTransition("FAILED", "PENDING"),
    ).not.toThrow();
  });

  it("rejects reprocessing a PROCESSED trigger", () => {
    expect(() =>
      StateMachine.assertAgencyTriggerTransition("PROCESSED", "PROCESSING"),
    ).toThrow(AgentelseError);
  });
});
