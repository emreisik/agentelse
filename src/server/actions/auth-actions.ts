"use server";

import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { signOut } from "@/lib/auth";
import { isRateLimited } from "@/lib/rate-limit";

const REGISTER_WINDOW_MS = 60 * 60_000;
const REGISTER_MAX_PER_IP = 10;

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

const registerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  workspaceName: z.string().min(1, "Company/team name is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type RegisterResult = { ok: true } | { ok: false; error: string };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Self-signup: creates a new Workspace + user as OWNER.
// Project/Brand are not created here — that's the flow handled by the
// existing createProjectAction (project-actions.ts), which leads into the
// 12-stage Agency Setup; register only completes the "a workspace you own"
// step, and the user starts their first project themselves from /dashboard.
export async function registerAction(
  input: RegisterInput,
): Promise<RegisterResult> {
  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const ip = forwardedFor ? forwardedFor.split(",")[0]!.trim() : "unknown";
  if (
    isRateLimited(`register:ip:${ip}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW_MS)
  ) {
    return { ok: false, error: "Too many attempts. Please try again later." };
  }

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid form data",
    };
  }
  const { name, email, password, workspaceName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "An account with this email already exists" };
  }

  const baseSlug = slugify(workspaceName) || "workspace";
  let slug = baseSlug;
  let suffix = 0;
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: workspaceName, slug },
      });
      const user = await tx.user.create({
        data: { name, email, passwordHash },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: false, error: "An account with this email already exists" };
    }
    throw error;
  }

  return { ok: true };
}
