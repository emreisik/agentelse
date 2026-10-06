"use server";

import { revalidatePath } from "next/cache";

import {
  missingFullPrerequisites,
  type AutonomyLevel,
} from "@/lib/ads/autopilot";
import { AdsFlags } from "@/lib/ads/flags";
import { toMinorUnits } from "@/lib/ads/money";
import { prisma } from "@/lib/prisma";
import { AdsAutopilot } from "@/server/ads/autopilot";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Settings → Autonomy → Ads autopilot (docs/meta-ads-plan.md §1.2, F7).
// Proje bazında açık rıza: yalnız workspace OWNER/ADMIN değiştirir, Suggest
// dışındaki seviye onay kutusu ister, FULL önkoşulları sunucuda denetlenir.
// Her değişiklik AuditLog'a yazılır.

export type ActionResult = { ok: true } | { ok: false; message: string };

const LEVELS: readonly AutonomyLevel[] = ["SUGGEST", "GUARDED", "FULL"];
const ADMIN_ROLES = new Set(["OWNER", "ADMIN"]);

export async function updateAdsAutopilotAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!AdsFlags.autopilot()) {
      return { ok: false, message: "Ads autopilot isn't available yet." };
    }
    const member = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: access.workspaceId, userId },
      },
      select: { role: true },
    });
    if (!member || !ADMIN_ROLES.has(member.role)) {
      return {
        ok: false,
        message: "Only a workspace owner or admin can change Ads autopilot.",
      };
    }

    const level = String(formData.get("adsAutonomy") ?? "") as AutonomyLevel;
    if (!LEVELS.includes(level)) {
      return {
        ok: false,
        message: "Pick how much Agentelse may do on its own.",
      };
    }
    if (level !== "SUGGEST" && formData.get("adsAutopilotConsent") !== "on") {
      return {
        ok: false,
        message: "Tick the box to let Agentelse change your ads on its own.",
      };
    }

    const link = await prisma.adsAccountProject.findFirst({
      where: { projectId, selected: true },
      select: { adsAccount: { select: { currency: true } } },
    });
    const capText = String(formData.get("adsMonthlyCap") ?? "").trim();
    let capMinor: number | null = null;
    if (capText) {
      const major = Number(capText);
      if (!Number.isFinite(major) || major <= 0) {
        return {
          ok: false,
          message: "The monthly cap has to be a positive amount.",
        };
      }
      capMinor = toMinorUnits(major, link?.adsAccount.currency ?? null);
    }

    if (level === "FULL") {
      const prerequisites = await AdsAutopilot.fullPrerequisites(projectId);
      const missing = missingFullPrerequisites({
        ...prerequisites,
        monthlyCapSet: capMinor !== null,
      });
      if (missing.length > 0) {
        return {
          ok: false,
          message: `Full auto needs: ${missing.join("; ")}.`,
        };
      }
    }

    const current = await prisma.autonomyPolicy.findUnique({
      where: { projectId },
      select: { adsAutonomy: true, adsMonthlyCapMinor: true },
    });
    if (!current)
      return { ok: false, message: "This project has no autonomy policy." };
    await prisma.autonomyPolicy.update({
      where: { projectId },
      data: {
        adsAutonomy: level,
        adsMonthlyCapMinor: capMinor === null ? null : BigInt(capMinor),
      },
    });
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "ads_autopilot.updated",
      entityType: "AutonomyPolicy",
      entityId: projectId,
      metadata: {
        from: current.adsAutonomy,
        to: level,
        monthlyCapMinor: capMinor,
        previousMonthlyCapMinor:
          current.adsMonthlyCapMinor === null
            ? null
            : Number(current.adsMonthlyCapMinor),
        consent: level !== "SUGGEST",
      },
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Couldn't save Ads autopilot.",
    };
  }
}

// F8 müşteri onaylayıcıları (Settings → Autonomy → Spend approvers): OWNER /
// ADMIN olmayan üyelerden bu projenin L4 harcama onayını verebilecekler.
export async function updateSpendApproversAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!AdsFlags.agency()) {
      return { ok: false, message: "Spend approvers aren't available yet." };
    }
    const member = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: access.workspaceId, userId },
      },
      select: { role: true },
    });
    if (!member || !ADMIN_ROLES.has(member.role)) {
      return {
        ok: false,
        message: "Only a workspace owner or admin can choose spend approvers.",
      };
    }
    const picked = formData
      .getAll("approverIds")
      .map((value) => String(value))
      .filter(Boolean);
    // Yalnız bu workspace'in MEMBER'ları (OWNER/ADMIN zaten onaylayabilir).
    const members = await prisma.workspaceMember.findMany({
      where: {
        workspaceId: access.workspaceId,
        role: "MEMBER",
        userId: { in: picked },
      },
      select: { userId: true },
    });
    const approverIds = members.map((row) => row.userId);
    const current = await prisma.autonomyPolicy.findUnique({
      where: { projectId },
      select: { adsSpendApproverIds: true },
    });
    if (!current) return { ok: false, message: "This project has no autonomy policy." };
    await prisma.autonomyPolicy.update({
      where: { projectId },
      data: { adsSpendApproverIds: approverIds },
    });
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "ads_spend_approvers.updated",
      entityType: "AutonomyPolicy",
      entityId: projectId,
      metadata: { from: current.adsSpendApproverIds, to: approverIds },
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Couldn't save spend approvers.",
    };
  }
}
