import "server-only";

import { prisma } from "@/lib/prisma";
import {
  GOOGLE_PROVIDER,
  type GoogleService,
} from "@/server/integrations/google/services";

// "Use existing connection" (docs/google-analytics-plan.md §3.2, GK5): bir
// Google hesabı aynı workspace'te başka bir projeye OAuth'a gitmeden bağlanır;
// mevcut bağlantının şifreli refresh token'ı kopyalanır. Böylece Google'ın
// "Google hesabı × OAuth istemcisi başına 100 refresh token" sınırı ajanslarda
// dolmaz: her proje bağlantısı yeni token üretseydi, sınır aşılınca en eski
// bağlantılar uyarısız düşerdi. Aynı token'ı paylaşan satırları akıllı iptal
// zaten tanır (revoke-policy.ts): biri koparılınca Google'da iptal yapılmaz.

export type GoogleReuseOption = {
  credentialId: string;
  email: string;
  projectName: string;
};

const MAX_OPTIONS = 20;

export async function listReusableGoogleConnections(input: {
  workspaceId: string;
  projectId: string;
  service: GoogleService;
}): Promise<GoogleReuseOption[]> {
  const rows = await prisma.integrationCredential.findMany({
    where: {
      workspaceId: input.workspaceId,
      provider: GOOGLE_PROVIDER[input.service],
      status: "ACTIVE",
      projectId: { not: input.projectId },
      NOT: { encryptedSecret: "" },
    },
    select: { id: true, accountLabel: true, metadata: true, projectId: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  if (rows.length === 0) return [];

  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.projectId))] } },
    select: { id: true, name: true },
  });
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  // Aynı Google hesabı bir kez listelenir (önce hesap kimliği, yoksa e-posta).
  const seen = new Set<string>();
  const options: GoogleReuseOption[] = [];
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as {
      googleSub?: unknown;
      connectedEmail?: unknown;
    };
    const email =
      typeof metadata.connectedEmail === "string"
        ? metadata.connectedEmail
        : row.accountLabel;
    if (!email) continue;
    const key =
      typeof metadata.googleSub === "string"
        ? metadata.googleSub
        : email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      credentialId: row.id,
      email,
      projectName: projectName.get(row.projectId) ?? "another project",
    });
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}
