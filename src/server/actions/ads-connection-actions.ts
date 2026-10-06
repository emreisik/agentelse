"use server";

import { revalidatePath } from "next/cache";

import { AdsFlags } from "@/lib/ads/flags";
import { prisma } from "@/lib/prisma";
import { AdsConnections } from "@/server/ads/connections";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// Ajans bağlantıları (/ads, docs/meta-ads-plan.md F8): hesabı projeye atama
// ve bağlantıyı kesme. Yalnız workspace OWNER/ADMIN.

export type ActionResult = { ok: true } | { ok: false; message: string };

async function requireAdmin(): Promise<
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; message: string }
> {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  if (!AdsFlags.agency())
    return {
      ok: false,
      message: "Ad account connections aren't available yet.",
    };
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
    return {
      ok: false,
      message:
        "Only a workspace owner or admin can manage ad account connections.",
    };
  }
  return { ok: true, userId, workspaceId };
}

export async function assignAdsAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin;
    const connectionId = String(formData.get("connectionId") ?? "");
    const adAccountId = String(formData.get("adAccountId") ?? "");
    const projectId = String(formData.get("projectId") ?? "");
    const pageId = String(formData.get("pageId") ?? "") || null;
    if (!connectionId || !adAccountId || !projectId) {
      return { ok: false, message: "Pick a project for this ad account." };
    }
    const result = await AdsConnections.assign({
      connectionId,
      workspaceId: admin.workspaceId,
      projectId,
      adAccountId,
      pageId,
      userId: admin.userId,
    });
    if (result.ok) {
      revalidatePath("/ads");
      revalidatePath(`/projects/${projectId}`);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Couldn't assign the ad account.",
    };
  }
}

export async function disconnectAdsConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin;
    const connectionId = String(formData.get("connectionId") ?? "");
    const result = await AdsConnections.disconnect({
      connectionId,
      workspaceId: admin.workspaceId,
      userId: admin.userId,
    });
    if (result.ok) revalidatePath("/ads");
    return result;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Couldn't disconnect.",
    };
  }
}
