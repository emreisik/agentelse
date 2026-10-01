import "server-only";

import { getEnv } from "@/lib/env";
import { parseSignedRequest } from "@/lib/meta-signed-request";
import { prisma } from "@/lib/prisma";
import { META_PROVIDER } from "@/server/integrations/meta-client";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// What happens when a person removes Agentelse in Instagram (deauthorize) or
// asks Meta to delete their data (data deletion). Both only concern the
// Instagram Login connection: it is the one stored against the account's own id,
// so a request can be matched to it. (The Facebook route stores no Facebook user
// id, so a request for one of those matches nothing and is a harmless no-op.)

// The signed `user_id` is Instagram's app-scoped id, which is not always the
// professional account id publishing uses, so a connection stores both and
// either one matches.
function ownedBy(userId: string) {
  return {
    provider: META_PROVIDER.instagram,
    OR: [
      { metadata: { path: ["instagramAccount", "id"], equals: userId } },
      { metadata: { path: ["instagramAccount", "appScopedId"], equals: userId } },
    ],
  };
}

// The user id inside a request that Meta really signed, else null.
export async function readSignedUserId(request: Request): Promise<string | null> {
  let signedRequest: FormDataEntryValue | null = null;
  try {
    signedRequest = (await request.formData()).get("signed_request");
  } catch {
    return null;
  }
  if (typeof signedRequest !== "string") return null;
  const env = getEnv();
  return (
    parseSignedRequest(signedRequest, [
      env.INSTAGRAM_APP_SECRET,
      env.META_APP_SECRET,
    ])?.userId ?? null
  );
}

// The person removed the app: stop using the connection. The account's details
// stay (so the workspace can see what was connected) until a deletion request.
export async function deauthorizeInstagramUser(userId: string): Promise<number> {
  const rows = await prisma.integrationCredential.findMany({
    where: { ...ownedBy(userId), NOT: { status: "REVOKED" } },
    select: { id: true, workspaceId: true, projectId: true },
  });
  for (const row of rows) {
    await prisma.integrationCredential.update({
      where: { id: row.id },
      data: { status: "REVOKED" },
    });
    await AuditLogRepository.record({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      actorType: "SYSTEM",
      action: "integration_credential.deauthorized_by_instagram",
      entityType: "IntegrationCredential",
      entityId: row.id,
      metadata: { provider: META_PROVIDER.instagram },
    });
  }
  return rows.length;
}

// A deletion request: erase what Agentelse holds from Instagram for this person
// (the connection row: access token, account id, username, account type).
// Published posts stay: they are the workspace's own content.
export async function deleteInstagramUserData(userId: string): Promise<number> {
  const rows = await prisma.integrationCredential.findMany({
    where: ownedBy(userId),
    select: { id: true, workspaceId: true, projectId: true },
  });
  for (const row of rows) {
    await prisma.integrationCredential.delete({ where: { id: row.id } });
    await AuditLogRepository.record({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      actorType: "SYSTEM",
      action: "integration_credential.deleted_on_user_request",
      entityType: "IntegrationCredential",
      entityId: row.id,
      metadata: { provider: META_PROVIDER.instagram },
    });
  }
  return rows.length;
}
