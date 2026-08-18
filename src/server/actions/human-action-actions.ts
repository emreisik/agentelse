"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { HumanInterventionService } from "@/server/services/human-intervention.service";

export type ActionResult = { ok: true } | { ok: false; message: string };

export async function resolveHumanActionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const requestId = String(formData.get("requestId"));
    const value = String(formData.get("value") ?? "");
    if (!value.trim()) return { ok: false, message: "Value cannot be empty" };

    const { userId } = await requireUser();
    const request = await prisma.humanInterventionRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    await requireProjectAccess(userId, request.projectId);

    await HumanInterventionService.resolveWithValue(
      requestId,
      request.projectId,
      userId,
      value,
    );

    revalidatePath("/human-actions");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export async function cancelHumanActionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const requestId = String(formData.get("requestId"));

    const { userId } = await requireUser();
    const request = await prisma.humanInterventionRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    await requireProjectAccess(userId, request.projectId);

    await HumanInterventionService.cancel(requestId, request.projectId);

    revalidatePath("/human-actions");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
