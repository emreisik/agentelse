import "server-only";

import { getEnv } from "@/lib/env";
import { parseSignedRequest } from "@/lib/meta-signed-request";
import { prisma } from "@/lib/prisma";
import { META_PROVIDER } from "@/server/integrations/meta-client";

// What happens when a person removes Agentelse (deauthorize) or asks Meta to
// delete their data (data deletion). An Instagram Login connection is stored
// against the account's own id; a Facebook-route connection (Facebook, Instagram
// through a Page, Meta Ads) against the person's app-scoped Facebook user id,
// written when it connects (docs/meta-ads-plan.md F1). Either matches.

// Instagram's signed `user_id` is its app-scoped id, which is not always the
// professional account id publishing uses, so that connection stores both.
function ownedBy(userId: string) {
  return {
    OR: [
      {
        provider: META_PROVIDER.instagram,
        OR: [
          { metadata: { path: ["instagramAccount", "id"], equals: userId } },
          {
            metadata: {
              path: ["instagramAccount", "appScopedId"],
              equals: userId,
            },
          },
        ],
      },
      {
        provider: {
          in: [META_PROVIDER.instagram, META_PROVIDER.facebook, META_PROVIDER.ads],
        },
        metadata: { path: ["appScopedUserId"], equals: userId },
      },
    ],
  };
}

// A real callback body is `signed_request=<a few hundred characters>`. Cap what is
// read so a caller with no session can't make the server buffer or parse megabytes.
const MAX_BODY_BYTES = 16 * 1024;

async function readLimitedText(
  request: Request,
  limit: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The user id inside a request that Meta really signed, else null. Meta sends a
// urlencoded form with one `signed_request` field.
export async function readSignedUserId(request: Request): Promise<string | null> {
  const body = await readLimitedText(request, MAX_BODY_BYTES);
  if (body === null) return null;
  const signedRequest = new URLSearchParams(body).get("signed_request");
  if (!signedRequest) return null;
  const env = getEnv();
  return (
    parseSignedRequest(signedRequest, [
      env.INSTAGRAM_APP_SECRET,
      env.META_APP_SECRET,
    ])?.userId ?? null
  );
}

// Meta resends a callback it thinks timed out, and a person can trigger a
// deauthorize and a deletion together, so each row is handled as ONE atomic unit
// that is safe to repeat: the change and its audit entry commit together, a row
// that is already gone or already revoked counts as zero (never an error), and only
// what this call really changed is counted. (Writing the audit first would record
// an erasure that may not have happened; writing it after would lose it when the
// second write fails and the retry finds nothing left to do.)

// The person removed the app: stop using the connection. The account's details
// stay (so the workspace can see what was connected) until a deletion request.
export async function deauthorizeInstagramUser(userId: string): Promise<number> {
  const rows = await prisma.integrationCredential.findMany({
    where: { ...ownedBy(userId), NOT: { status: "REVOKED" } },
    select: { id: true, workspaceId: true, projectId: true, provider: true },
  });
  let revoked = 0;
  for (const row of rows) {
    revoked += await prisma.$transaction(async (tx) => {
      const { count } = await tx.integrationCredential.updateMany({
        where: { id: row.id, NOT: { status: "REVOKED" } },
        data: { status: "REVOKED" },
      });
      if (count > 0) {
        await tx.auditLog.create({
          data: {
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            actorType: "SYSTEM",
            action:
              row.provider === META_PROVIDER.instagram
                ? "integration_credential.deauthorized_by_instagram"
                : "integration_credential.deauthorized_by_meta",
            entityType: "IntegrationCredential",
            entityId: row.id,
            metadata: { provider: row.provider },
          },
        });
      }
      return count;
    });
  }
  return revoked;
}

// A deletion request: erase what Agentelse holds from Instagram for this person
// (the connection row: access token, account id, username, account type).
// Published posts stay: they are the workspace's own content.
export async function deleteInstagramUserData(userId: string): Promise<number> {
  const rows = await prisma.integrationCredential.findMany({
    where: ownedBy(userId),
    select: { id: true, workspaceId: true, projectId: true, provider: true },
  });
  let erased = 0;
  for (const row of rows) {
    erased += await prisma.$transaction(async (tx) => {
      // Meta Ads: the mirror of the account goes with the connection
      // (docs/meta-ads-plan.md F2, K7). The write log (AdsOperation) stays as
      // the workspace's own audit record.
      if (row.provider === META_PROVIDER.ads) {
        const accounts = await tx.adsAccount.findMany({
          where: { credentialId: row.id },
          select: { id: true },
        });
        const ids = accounts.map((account) => account.id);
        if (ids.length > 0) {
          await tx.adsInsightDaily.deleteMany({ where: { adsAccountId: { in: ids } } });
          await tx.adsObject.deleteMany({ where: { adsAccountId: { in: ids } } });
          await tx.adsAlert.deleteMany({ where: { adsAccountId: { in: ids } } });
          await tx.adsAccount.deleteMany({ where: { id: { in: ids } } });
        }
      }
      const { count } = await tx.integrationCredential.deleteMany({
        where: { id: row.id },
      });
      if (count > 0) {
        await tx.auditLog.create({
          data: {
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            actorType: "SYSTEM",
            action: "integration_credential.deleted_on_user_request",
            entityType: "IntegrationCredential",
            entityId: row.id,
            metadata: { provider: row.provider },
          },
        });
      }
      return count;
    });
  }
  return erased;
}
