"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/components/shared/action-form";
import { dayKeyToDate } from "@/lib/seo/dates";
import { SeoFlags } from "@/lib/seo/health-flags";
import { SEARCH_UPDATE_KINDS } from "@/lib/seo/search-updates";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isPlatformOperator } from "@/server/security/operator";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { SearchUpdates } from "@/server/seo/health/updates";

// /health/search-updates eylemleri (docs/search-health.md "Google
// güncellemeleri"): yalnız platform operatörü, Status Dashboard'da olmayan
// bir güncellemeyi elle ekler ya da elle eklediğini siler. Proje verisi yok;
// denetim kaydı operatörün çalışma alanına yazılır.

const PAGE_PATH = "/health/search-updates";
const NOT_ALLOWED = "Only the platform operator can do this.";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid day")
  .refine((value) => {
    const parsed = dayKeyToDate(value);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Pick a valid day");

const addSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3, "Name the update")
      .max(200, "The name is too long"),
    kind: z.enum(SEARCH_UPDATE_KINDS),
    startedAt: day,
    endedAt: z.union([day, z.literal("")]),
    url: z.union([
      z
        .string()
        .trim()
        .max(500, "The link is too long")
        .refine((value) => {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        }, "Use an https link"),
      z.literal(""),
    ]),
  })
  .refine((value) => !value.endedAt || value.endedAt >= value.startedAt, {
    message: "The end day must be on or after the start day",
    path: ["endedAt"],
  });

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function operator(): Promise<
  { ok: true; userId: string; workspaceId: string } | { ok: false }
> {
  const { userId } = await requireUser();
  if (!SeoFlags.health() || !isPlatformOperator(userId)) return { ok: false };
  const { workspaceId } = await requireWorkspaceMembership(userId);
  return { ok: true, userId, workspaceId };
}

export async function addSearchUpdateAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await operator();
    if (!actor.ok) return { ok: false, message: NOT_ALLOWED };
    const parsed = addSchema.safeParse({
      name: field(formData, "name"),
      kind: field(formData, "kind"),
      startedAt: field(formData, "startedAt"),
      endedAt: field(formData, "endedAt"),
      url: field(formData, "url"),
    });
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues[0]?.message ?? "Check the form",
      };
    }
    const input = parsed.data;
    const startedAt = dayKeyToDate(input.startedAt);
    const endedAt = input.endedAt ? dayKeyToDate(input.endedAt) : null;
    const { id } = await SearchUpdates.addManual({
      name: input.name,
      kind: input.kind,
      startedAt,
      endedAt,
      url: input.url || null,
      userId: actor.userId,
    });
    await AuditLogRepository.record({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "search_update.added",
      entityType: "SearchUpdate",
      entityId: id,
      metadata: {
        name: input.name,
        kind: input.kind,
        startedAt: input.startedAt,
        endedAt: input.endedAt || null,
      },
    });
    revalidatePath(PAGE_PATH);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export async function removeSearchUpdateAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const actor = await operator();
    if (!actor.ok) return { ok: false, message: NOT_ALLOWED };
    const id = field(formData, "id").trim();
    if (!id) return { ok: false, message: "Record not found" };
    const removed = await SearchUpdates.removeManual(id);
    if (!removed) {
      return {
        ok: false,
        message: "Only updates added by hand can be removed",
      };
    }
    await AuditLogRepository.record({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "search_update.removed",
      entityType: "SearchUpdate",
      entityId: id,
    });
    revalidatePath(PAGE_PATH);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
