import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { ApprovalPolicy } from "@/server/execution/approval-policy";
import { describeIntegration } from "@/test-support/integration-suite";

import { costApprovalContext } from "./approval-threshold";

// The size of automatic work that waits for a person (Faz 3C), read for a real
// workspace: its plan decides the default, the project's own choice overrides it
// inside the plan's range.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const fixtures: AgencyFixture[] = [];

async function workspace(
  plan: "starter" | "growth" | null,
  options: { approveAboveUsd?: number } = {},
) {
  const fixture = await createAgencyFixture(`thr-${runId}-${counter++}`);
  fixtures.push(fixture);
  if (plan) {
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: plan,
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: new Date(Date.now() - 24 * 60 * 60 * 1000),
        paidThrough: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      },
    });
  }
  await prisma.autonomyPolicy.upsert({
    where: { projectId: fixture.projectId },
    create: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      approveAboveUsd: options.approveAboveUsd ?? null,
    },
    update: { approveAboveUsd: options.approveAboveUsd ?? null },
  });
  return fixture;
}

const ask = (
  fixture: AgencyFixture,
  options: {
    createdByType?: "USER" | "SYSTEM" | "AI";
    capability?: "CREATE_SOCIAL_CREATIVE" | "INSTAGRAM_PUBLISH";
    variants?: number;
  } = {},
) =>
  costApprovalContext({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    capability: options.capability ?? "CREATE_SOCIAL_CREATIVE",
    payload: { request: "a post", variantCount: options.variants },
    createdByType: options.createdByType ?? "SYSTEM",
  });

describeIntegration("cost approval context", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) {
      await prisma.subscription.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("reads the plan's size and the task's estimate for work the system started", async () => {
    const fixture = await workspace("starter");

    const context = await ask(fixture, { variants: 3 });

    expect(context.approveAboveUsd).toBe(APPROVE_ABOVE_USD.starter);
    expect(context.estimatedCostUsd).toBeGreaterThan(APPROVE_ABOVE_USD.starter);
    expect(context.note).toContain("3 post images");
    // The policy turns it into a question for a person.
    expect(
      ApprovalPolicy.resolveLevel("CREATE_SOCIAL_CREATIVE", {
        createdByType: "SYSTEM",
        estimatedCostUsd: context.estimatedCostUsd,
        approveAboveUsd: context.approveAboveUsd,
      }),
    ).toBe("LEVEL_3_CLIENT");
  });

  it("a single picture is under every plan's size: no note, nothing to ask", async () => {
    const fixture = await workspace("starter");

    const context = await ask(fixture);

    expect(context.estimatedCostUsd).toBeLessThanOrEqual(
      APPROVE_ABOVE_USD.starter,
    );
    expect(context.note).toBeUndefined();
  });

  it("a bigger plan trusts bigger automatic tasks", async () => {
    const starter = await workspace("starter");
    const growth = await workspace("growth");

    const small = await ask(starter, { variants: 2 });
    const big = await ask(growth, { variants: 2 });

    expect(small.note).toBeDefined(); // 2 pictures > Starter's size
    expect(big.note).toBeUndefined(); // ...but within Growth's
  });

  it("the project's own choice replaces the plan's size", async () => {
    const strict = await workspace("growth", { approveAboveUsd: 0.2 });
    const relaxed = await workspace("starter", { approveAboveUsd: 2.5 });

    const one = await ask(strict);
    const three = await ask(relaxed, { variants: 3 });

    expect(one.approveAboveUsd).toBe(0.2);
    expect(one.note).toBeDefined();
    expect(three.approveAboveUsd).toBe(2.5);
    expect(three.note).toBeUndefined();
  });

  it("a choice outside the plan's range is pulled back into it", async () => {
    const fixture = await workspace("starter", { approveAboveUsd: 90 });

    const context = await ask(fixture, { variants: 3 });

    expect(context.approveAboveUsd).toBe(APPROVE_ABOVE_USD.starter * 5);
  });

  it("says nothing for what the user started, free work, no plan, or when billing is not enforcing", async () => {
    const fixture = await workspace("starter");

    expect(await ask(fixture, { createdByType: "USER", variants: 3 })).toEqual(
      {},
    );
    expect(await ask(fixture, { capability: "INSTAGRAM_PUBLISH" })).toEqual({});
    expect(await ask(await workspace(null), { variants: 3 })).toEqual({});
    config.current = { mode: "shadow", legacyBefore: null, legacyUntil: null };
    expect(await ask(fixture, { variants: 3 })).toEqual({});
    config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
    expect(await ask(fixture, { variants: 3 })).toEqual({});
  });
});
