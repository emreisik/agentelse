"use server";

import bcrypt from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/security/tenant-context";
import { isRateLimited } from "@/lib/rate-limit";
import type { ActionResult } from "@/components/shared/action-form";

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export async function updateProfileAction(
  formData: FormData,
): Promise<ActionResult> {
  const parsed = updateProfileSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { userId } = await requireUser();
  await prisma.user.update({
    where: { id: userId },
    data: { name: parsed.data.name },
  });

  return { ok: true };
}

const CHANGE_PASSWORD_WINDOW_MS = 15 * 60_000;
const CHANGE_PASSWORD_MAX_PER_USER = 5;

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export async function changePasswordAction(
  formData: FormData,
): Promise<ActionResult> {
  const { userId } = await requireUser();

  // Keyed by userId, not IP: the attacker here is a signed-in session
  // guessing the account's current password, not an anonymous requester.
  if (
    isRateLimited(
      `change-password:${userId}`,
      CHANGE_PASSWORD_MAX_PER_USER,
      CHANGE_PASSWORD_WINDOW_MS,
    )
  ) {
    return {
      ok: false,
      message: "Too many attempts. Please try again later.",
    };
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) {
    return { ok: false, message: "This account has no password set" };
  }

  const valid = await bcrypt.compare(
    parsed.data.currentPassword,
    user.passwordHash,
  );
  if (!valid) {
    return { ok: false, message: "Current password is incorrect" };
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return { ok: true };
}
