"use server";

import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { signOut } from "@/lib/auth";

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

const registerSchema = z.object({
  name: z.string().min(1, "İsim gerekli"),
  email: z.string().email("Geçerli bir e-posta adresi girin"),
  password: z.string().min(8, "Şifre en az 8 karakter olmalı"),
  workspaceName: z.string().min(1, "Şirket/ekip adı gerekli"),
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

// Self-signup: yeni bir Workspace + kullanıcıyı OWNER olarak oluşturur.
// Proje/Marka burada oluşturulmuyor — o, mevcut createProjectAction'ın
// (project-actions.ts) 12 aşamalı Ajans Kurulumu'na götüren akışı; register
// sadece "sahibi olduğun bir çalışma alanı" adımını tamamlar, kullanıcı
// /dashboard'dan ilk projesini kendi başlatır.
export async function registerAction(
  input: RegisterInput,
): Promise<RegisterResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Geçersiz form verisi",
    };
  }
  const { name, email, password, workspaceName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false, error: "Bu e-posta adresiyle zaten bir hesap var" };
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
      return { ok: false, error: "Bu e-posta adresiyle zaten bir hesap var" };
    }
    throw error;
  }

  return { ok: true };
}
