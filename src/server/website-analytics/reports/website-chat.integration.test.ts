import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { websiteWorkId } from "@/lib/website-analytics/reports/ids";
import { sampleWeeklyCard } from "@/lib/website-analytics/reports/test-fixtures";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { cleanupGaReportSeed, seedGaReportLink } from "./test-support";
import {
  postToWebsiteChat,
  stepResultOf,
  websiteReportExists,
} from "./website-chat";

// GA-F5 Website analytics sohbeti gerçek Postgres'e karşı: ilk kart wkga_
// Work'ünü (module analytics) ve SYSTEM komutunu açar; aynı kimlik "exists"
// döner ve tek satır kalır; arşivlenmiş sohbete reopen:false "closed", true
// sohbeti yeniden açıp yazar; silinmiş bağ "gone" döner.

describeIntegration("Website analytics chat posting (GA-F5)", () => {
  const runId = randomUUID().slice(0, 8);
  const now = new Date("2026-10-05T10:00:00.000Z");
  let fixture: AgencyFixture;
  let linkId: string;

  function post(commandId: string, reopen: boolean) {
    return postToWebsiteChat({
      projectId: fixture.projectId,
      linkId,
      commandId,
      card: sampleWeeklyCard({
        projectId: fixture.projectId,
        linkId,
      }),
      text: "Weekly website report: digest.",
      summary: "Weekly website report",
      reopen,
      now,
    });
  }

  beforeAll(async () => {
    fixture = await createAgencyFixture(`ga-chat-${runId}`);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: "2026-10-04",
      days: 3,
      sessions: () => 100,
    });
    linkId = seeded.linkId;
  });

  afterAll(async () => {
    await cleanupGaReportSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  const workId = () => websiteWorkId(fixture.projectId);
  const commandId = (key: string) => `garep_weekly_${fixture.projectId}_${key}`;

  it("creates the Website analytics Work with the first card", async () => {
    expect(await websiteReportExists(commandId("a"))).toBe(false);
    expect(await post(commandId("a"), false)).toBe("posted");
    const work = await prisma.work.findUnique({ where: { id: workId() } });
    expect(work).toMatchObject({
      module: "analytics",
      title: "Website analytics",
      status: "ACTIVE",
      summary: "Weekly website report",
    });
    const command = await prisma.command.findUnique({
      where: { id: commandId("a") },
    });
    expect(command).toMatchObject({
      source: "SYSTEM",
      workId: workId(),
      brandId: fixture.brandId,
      replyText: "Weekly website report: digest.",
      replyStatus: "ANSWERED",
    });
    const intent = command?.parsedIntent as { card?: { kind?: string } } | null;
    expect(intent?.card?.kind).toBe("website-report");
    expect(await websiteReportExists(commandId("a"))).toBe(true);
  });

  it("returns exists for the same id and keeps a single row", async () => {
    expect(await post(commandId("a"), false)).toBe("exists");
    const rows = await prisma.command.count({
      where: { id: commandId("a") },
    });
    expect(rows).toBe(1);
    expect(stepResultOf("exists")).toBe("exists");
  });

  it("does not post into a closed chat unless asked to reopen", async () => {
    await prisma.work.update({
      where: { id: workId() },
      data: { status: "ARCHIVED" },
    });
    expect(await post(commandId("b"), false)).toBe("closed");
    expect(await websiteReportExists(commandId("b"))).toBe(false);
    expect(
      (await prisma.work.findUnique({ where: { id: workId() } }))?.status,
    ).toBe("ARCHIVED");

    expect(await post(commandId("b"), true)).toBe("posted");
    expect(
      (await prisma.work.findUnique({ where: { id: workId() } }))?.status,
    ).toBe("ACTIVE");
    expect(await websiteReportExists(commandId("b"))).toBe(true);
  });

  it("returns gone when the link was deleted", async () => {
    await prisma.gaPropertyLink.delete({ where: { id: linkId } });
    expect(await post(commandId("c"), true)).toBe("gone");
    expect(await websiteReportExists(commandId("c"))).toBe(false);
    expect(stepResultOf("gone")).toBe("gone");
    expect(stepResultOf("no_project")).toBe("gone");
    expect(stepResultOf("closed")).toBe("closed");
    expect(stepResultOf("posted")).toBe("posted");
  });

  it("returns no_project for an unknown project", async () => {
    expect(
      await postToWebsiteChat({
        projectId: `missing-${runId}`,
        linkId,
        commandId: `garep_weekly_missing_${runId}`,
        card: sampleWeeklyCard(),
        text: "x",
        summary: "x",
        reopen: false,
        now,
      }),
    ).toBe("no_project");
  });
});
