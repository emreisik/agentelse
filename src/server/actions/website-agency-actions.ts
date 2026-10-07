"use server";

import { revalidatePath } from "next/cache";

import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import { WEBSITES_OVERVIEW_HREF } from "@/lib/website-analytics/agency/routes";
import {
  BULK_LINK_MAX,
  bulkLinkGoogleAccount,
  type BulkLinkRow,
} from "@/server/website-analytics/agency/bulk-link";
import {
  isWorkspaceManager,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// Websites görünümünün eylemleri (GA-F8). Bir Google hesabının erişimini
// birçok projeye taşıdığı için yalnız OWNER/ADMIN.

type BulkLinkActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

const SKIP_LABEL: Record<NonNullable<BulkLinkRow["reason"]>, string> = {
  not_found: "not found",
  closed: "closed",
  already_connected: "already connected",
  other_workspace: "not in this workspace",
  not_allowed: "not allowed here",
};

// "Skipped 3 (2 already connected, 1 closed)"
function skippedSummary(rows: readonly BulkLinkRow[]): string {
  const skipped = rows.filter((row) => row.status === "skipped");
  if (skipped.length === 0) return "";
  const counts = new Map<string, number>();
  for (const row of skipped) {
    const label = row.reason ? SKIP_LABEL[row.reason] : "skipped";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => `${count} ${label}`);
  return `Skipped ${skipped.length} (${parts.join(", ")}).`;
}

export async function bulkLinkGoogleAccountAction(
  formData: FormData,
): Promise<BulkLinkActionResult> {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  if (!(await isWorkspaceManager(userId, workspaceId))) {
    return {
      ok: false,
      message: "Only workspace owners and admins can change this.",
    };
  }
  if (!gaAgencyEnabled()) {
    return { ok: false, message: "Agency tools aren't turned on." };
  }

  const sourceCredentialId = String(formData.get("sourceCredentialId") ?? "");
  const projectIds = [
    ...new Set(
      formData
        .getAll("projectId")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
  if (!sourceCredentialId) {
    return { ok: false, message: "Pick a Google account." };
  }
  if (projectIds.length === 0) {
    return { ok: false, message: "Pick at least one project." };
  }
  if (projectIds.length > BULK_LINK_MAX) {
    return {
      ok: false,
      message: `Pick up to ${BULK_LINK_MAX} projects at a time.`,
    };
  }

  const result = await bulkLinkGoogleAccount({
    workspaceId,
    userId,
    sourceCredentialId,
    projectIds,
    autoProperty: formData.get("autoProperty") === "on",
  });
  if (!result.ok) {
    const messages = {
      off: "Agency tools aren't turned on.",
      bad_source: "That Google account can't be used here. Pick another one.",
      too_many: `Pick up to ${BULK_LINK_MAX} projects at a time.`,
      token_invalid:
        "Google didn't accept that connection. Reconnect the account and try again.",
    } as const;
    return { ok: false, message: messages[result.reason] };
  }

  const skipped = skippedSummary(result.rows);
  if (result.linked === 0) {
    return {
      ok: false,
      message: ["No project was linked.", skipped].filter(Boolean).join(" "),
    };
  }
  revalidatePath(WEBSITES_OVERVIEW_HREF);
  return {
    ok: true,
    message: [
      `Linked ${result.linked} project${result.linked === 1 ? "" : "s"}.`,
      skipped,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
