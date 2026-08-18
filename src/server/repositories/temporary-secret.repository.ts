import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes, per spec section 27

export const TemporarySecretRepository = {
  store(input: {
    workspaceId: string;
    humanInterventionRequestId: string;
    value: string;
    ttlMs?: number;
  }) {
    return prisma.temporarySecret.create({
      data: {
        workspaceId: input.workspaceId,
        humanInterventionRequestId: input.humanInterventionRequestId,
        encryptedValue: encryptSecret(input.value),
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    });
  },

  // Single-use: marks consumedAt in the same call so a retried resume can't
  // replay the same OTP twice. Returns null once expired or already spent.
  async consume(humanInterventionRequestId: string): Promise<string | null> {
    const secret = await prisma.temporarySecret.findFirst({
      where: {
        humanInterventionRequestId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!secret) return null;

    await prisma.temporarySecret.update({
      where: { id: secret.id },
      data: { consumedAt: new Date() },
    });

    return decryptSecret(secret.encryptedValue);
  },

  // Called by the sweep worker; hard-deletes rather than soft-expiring so the
  // ciphertext never lingers past its TTL.
  deleteExpired() {
    return prisma.temporarySecret.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  },
};
