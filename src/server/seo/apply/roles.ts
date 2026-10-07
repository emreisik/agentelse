import "server-only";

import { prisma } from "@/lib/prisma";

// SC-F8 motorunun rol denetimi (docs/website-apply.md). Üye rolü satır içi
// aranır: tenant-context'i içe aktarmak next-auth'u işçi grafiğine taşırdı
// (worker-graph.test.ts bunu pinler). Yalnız prisma'ya dayanır.

const MANAGER_ROLES = new Set(["OWNER", "ADMIN"]);

// 'telegram:<id>' gibi sözde kullanıcıların rolü yoktur: sorgu yapılmadan false.
export async function isManagerInline(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  if (userId.includes(":")) return false;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return member !== null && MANAGER_ROLES.has(member.role);
}
