import { randomUUID } from "node:crypto";

import { afterAll, afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import { APPROVE_ABOVE_USD } from "@/lib/billing/approval-threshold";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { costApprovalContext } from "./approval-threshold";

// Gaps found by the mutation review of Faz 3C-2 (the approval size): the AI actor is
// "the system" too, and the helper never throws into task planning.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const fixtures: AgencyFixture[] = [];

async function starterWorkspace() {
  const fixture = await createAgencyFixture(`thrgap-${runId}-${counter++}`);
  fixtures.push(fixture);
  await prisma.subscription.create({
    data: {
      workspaceId: fixture.workspaceId,
      planKey: "starter",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: new Date(Date.now() - 24 * 60 * 60 * 1000),
      paidThrough: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    },
  });
  return fixture;
}

const ask = (
  fixture: AgencyFixture,
  createdByType: "USER" | "SYSTEM" | "AI",
  payload: unknown = { request: "a post", variantCount: 3 },
) =>
  costApprovalContext({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    capability: "CREATE_SOCIAL_CREATIVE",
    payload,
    createdByType,
  });

describeIntegration("cost approval context: gaps", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("work started by the AI is sized exactly like work started by the system", async () => {
    const fixture = await starterWorkspace();

    const bySystem = await ask(fixture, "SYSTEM");
    const byAi = await ask(fixture, "AI");

    expect(byAi).toEqual(bySystem);
    expect(byAi.approveAboveUsd).toBe(APPROVE_ABOVE_USD.starter);
    expect(byAi.note).toContain("3 post images");
  });

  it("never throws into task planning: a failure while sizing means the size is not applied", async () => {
    const fixture = await starterWorkspace();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("cannot read this payload");
        },
      },
    );

    await expect(ask(fixture, "SYSTEM", hostile)).resolves.toEqual({});
    expect(console.error).toHaveBeenCalled();
  });
});
