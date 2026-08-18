import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { TemporarySecretRepository } from "@/server/repositories/temporary-secret.repository";
import { describeIntegration } from "@/test-support/integration-suite";

// Verifies spec section 27 against the isolated TEST_DATABASE_URL.
describeIntegration("TemporarySecret lifecycle (spec section 27)", () => {
  const runId = randomUUID().slice(0, 8);
  let workspaceId: string;
  let projectId: string;
  let brandId: string;

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({
      data: {
        name: `TempSecret Test ${runId}`,
        slug: `tempsecret-test-${runId}`,
      },
    });
    workspaceId = workspace.id;

    const project = await prisma.project.create({
      data: { workspaceId, name: `Project ${runId}`, slug: `project-${runId}` },
    });
    projectId = project.id;

    const brand = await prisma.brand.create({
      data: {
        workspaceId,
        projectId,
        name: "Brand",
        slug: "default",
        isDefault: true,
      },
    });
    brandId = brand.id;
  });

  afterAll(async () => {
    if (!workspaceId) return;

    await prisma.temporarySecret.deleteMany({ where: { workspaceId } });
    await prisma.humanInterventionRequest.deleteMany({
      where: { workspaceId },
    });
    await prisma.brand.deleteMany({ where: { workspaceId } });
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  // Each test gets its own HumanInterventionRequest so consumed/unconsumed
  // state never leaks across tests — TemporarySecretRepository.consume()
  // deliberately looks up "the newest unconsumed secret for this request",
  // so two tests sharing one request id would see each other's leftovers.
  async function createRequest() {
    const request = await prisma.humanInterventionRequest.create({
      data: {
        workspaceId,
        projectId,
        brandId,
        type: "OTP_REQUIRED",
        inputType: "OTP",
        status: "PENDING",
        title: "Test OTP request",
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    return request.id;
  }

  it("stores the value encrypted, not as plaintext", async () => {
    const humanInterventionRequestId = await createRequest();

    const secret = await TemporarySecretRepository.store({
      workspaceId,
      humanInterventionRequestId,
      value: "482916",
    });

    const row = await prisma.temporarySecret.findUniqueOrThrow({
      where: { id: secret.id },
    });
    expect(row.encryptedValue).not.toContain("482916");
  });

  it("consumes the value exactly once", async () => {
    const humanInterventionRequestId = await createRequest();

    await TemporarySecretRepository.store({
      workspaceId,
      humanInterventionRequestId,
      value: "111222",
    });

    const first = await TemporarySecretRepository.consume(
      humanInterventionRequestId,
    );
    expect(first).toBe("111222");

    const second = await TemporarySecretRepository.consume(
      humanInterventionRequestId,
    );
    expect(second).toBeNull();
  });

  it("leaves no unconsumed rows behind after consumption", async () => {
    const humanInterventionRequestId = await createRequest();

    await TemporarySecretRepository.store({
      workspaceId,
      humanInterventionRequestId,
      value: "999000",
    });
    await TemporarySecretRepository.consume(humanInterventionRequestId);

    const unconsumed = await prisma.temporarySecret.count({
      where: { humanInterventionRequestId, consumedAt: null },
    });
    expect(unconsumed).toBe(0);
  });
});
