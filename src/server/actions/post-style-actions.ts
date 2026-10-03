"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import {
  FIDELITIES,
  MAX_DIRECTIVES_CHARS,
  MAX_LABEL_CHARS,
  type PostStyleFidelity,
} from "@/lib/post-style";
import { parseLinkLines } from "@/lib/post-style-links";
import {
  addExampleFromBytes,
  ensureVisualIdentityRow,
  fetchLinkImage,
  MAX_EXAMPLE_UPLOAD_BYTES,
  reanalyzeExample,
} from "@/server/brand/post-style-service";
import {
  getExample,
  removeExample,
  saveDirectives,
  saveExample,
} from "@/server/brand/post-style-store";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The Brand Brain's Post Style Kit: add example posts (pictures or links), write
// the standing instructions, switch examples on and off. Every action looks the
// project up for the signed-in user first and works on that project's brand.

const MAX_PER_REQUEST = 6;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ADD_LIMIT = { key: "post-style-add", max: 8, windowMs: 10 * 60_000 };
const EDIT_LIMIT = { key: "post-style-edit", max: 60, windowMs: 10 * 60_000 };

export type AddExamplesResult =
  | {
      ok: true;
      added: number;
      // How many of them were read into a design recipe.
      analyzed: number;
      failed: { name: string; reason: string }[];
    }
  | { ok: false; message: string };

export type PostStyleResult = { ok: true } | { ok: false; message: string };

const SLOW_DOWN = "Slow down for a moment.";

async function scopeOf(projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  return {
    userId,
    scope: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
    },
  };
}

// Two at a time: every example is a model call.
async function inBatches<T>(
  items: readonly (() => Promise<T>)[],
  size: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(...(await Promise.all(items.slice(at, at + size).map((run) => run()))));
  }
  return out;
}

export async function addPostStyleExamplesAction(
  formData: FormData,
): Promise<AddExamplesResult> {
  try {
    const found = await scopeOf(formData.get("projectId"));
    if (!found) return { ok: false, message: "Project not found." };
    const { userId, scope } = found;
    if (isRateLimited(`${ADD_LIMIT.key}:${userId}`, ADD_LIMIT.max, ADD_LIMIT.windowMs)) {
      return { ok: false, message: SLOW_DOWN };
    }

    const files = formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    const links = parseLinkLines(String(formData.get("links") ?? ""));
    if (files.length + links.length === 0) {
      return { ok: false, message: "Add at least one picture or link." };
    }
    if (files.length + links.length > MAX_PER_REQUEST) {
      return {
        ok: false,
        message: `Add at most ${MAX_PER_REQUEST} at a time.`,
      };
    }

    const jobs: (() => Promise<{
      name: string;
      result: Awaited<ReturnType<typeof addExampleFromBytes>>;
    }>)[] = [];
    for (const file of files) {
      jobs.push(async () => {
        if (!ACCEPTED_TYPES.has(file.type)) {
          return {
            name: file.name,
            result: { ok: false as const, reason: "Use a PNG, JPG or WebP picture." },
          };
        }
        if (file.size > MAX_EXAMPLE_UPLOAD_BYTES) {
          return {
            name: file.name,
            result: {
              ok: false as const,
              reason: `That picture is larger than ${MAX_EXAMPLE_UPLOAD_BYTES / 1024 / 1024} MB.`,
            },
          };
        }
        return {
          name: file.name,
          result: await addExampleFromBytes({
            scope,
            bytes: Buffer.from(await file.arrayBuffer()),
            label: file.name.replace(/\.[a-z0-9]+$/i, ""),
            source: "upload",
          }),
        };
      });
    }
    for (const link of links) {
      jobs.push(async () => {
        const fetched = await fetchLinkImage(link);
        if (!fetched.ok) {
          return { name: link, result: { ok: false as const, reason: fetched.reason } };
        }
        return {
          name: link,
          result: await addExampleFromBytes({
            scope,
            bytes: fetched.bytes,
            label: "",
            source: "link",
            url: link,
          }),
        };
      });
    }

    const settled = await inBatches(jobs, 2);
    const added = settled.filter((entry) => entry.result.ok);
    const failed = settled.flatMap((entry) =>
      entry.result.ok ? [] : [{ name: entry.name, reason: entry.result.reason }],
    );

    if (added.length > 0) {
      await AuditLogRepository.record({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        actorType: "USER",
        actorId: userId,
        action: "post_style.examples_added",
        entityType: "Brand",
        entityId: scope.brandId,
        metadata: { added: added.length, failed: failed.length },
      }).catch(() => undefined);
      revalidatePath(`/projects/${scope.projectId}`);
    }
    return {
      ok: true,
      added: added.length,
      analyzed: added.filter((entry) => entry.result.ok && entry.result.analyzed).length,
      failed,
    };
  } catch (error) {
    console.error(
      "[post-style] add failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: "That didn't work. Try again." };
  }
}

export async function updatePostStyleDirectivesAction(input: {
  projectId: string;
  text: string;
  fidelity: string;
}): Promise<PostStyleResult> {
  try {
    const found = await scopeOf(input?.projectId);
    if (!found) return { ok: false, message: "Project not found." };
    const { userId, scope } = found;
    if (isRateLimited(`${EDIT_LIMIT.key}:${userId}`, EDIT_LIMIT.max, EDIT_LIMIT.windowMs)) {
      return { ok: false, message: SLOW_DOWN };
    }
    if (typeof input.text !== "string" || input.text.length > MAX_DIRECTIVES_CHARS) {
      return {
        ok: false,
        message: `Keep the instructions under ${MAX_DIRECTIVES_CHARS} characters.`,
      };
    }
    if (!(FIDELITIES as readonly string[]).includes(input.fidelity)) {
      return { ok: false, message: "Pick how closely posts follow the examples." };
    }
    await ensureVisualIdentityRow(scope);
    await saveDirectives(scope, {
      text: input.text.trim(),
      fidelity: input.fidelity as PostStyleFidelity,
    });
    await AuditLogRepository.record({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      actorType: "USER",
      actorId: userId,
      action: "post_style.directives_saved",
      entityType: "Brand",
      entityId: scope.brandId,
      metadata: { length: input.text.trim().length, fidelity: input.fidelity },
    }).catch(() => undefined);
    revalidatePath(`/projects/${scope.projectId}`);
    return { ok: true };
  } catch (error) {
    console.error(
      "[post-style] directives failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: "That didn't work. Try again." };
  }
}

export async function setPostStyleExampleAction(input: {
  projectId: string;
  assetId: string;
  enabled?: boolean;
  label?: string;
}): Promise<PostStyleResult> {
  try {
    const found = await scopeOf(input?.projectId);
    if (!found) return { ok: false, message: "Project not found." };
    const { userId, scope } = found;
    if (isRateLimited(`${EDIT_LIMIT.key}:${userId}`, EDIT_LIMIT.max, EDIT_LIMIT.windowMs)) {
      return { ok: false, message: SLOW_DOWN };
    }
    const example = await getExample(scope.brandId, String(input.assetId));
    if (!example) return { ok: false, message: "That example is gone." };
    await saveExample(scope, {
      ...example,
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(typeof input.label === "string"
        ? {
            label: input.label
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, MAX_LABEL_CHARS),
          }
        : {}),
    });
    revalidatePath(`/projects/${scope.projectId}`);
    return { ok: true };
  } catch (error) {
    console.error(
      "[post-style] set failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: "That didn't work. Try again." };
  }
}

export async function removePostStyleExampleAction(input: {
  projectId: string;
  assetId: string;
}): Promise<PostStyleResult> {
  try {
    const found = await scopeOf(input?.projectId);
    if (!found) return { ok: false, message: "Project not found." };
    const { userId, scope } = found;
    if (isRateLimited(`${EDIT_LIMIT.key}:${userId}`, EDIT_LIMIT.max, EDIT_LIMIT.windowMs)) {
      return { ok: false, message: SLOW_DOWN };
    }
    // The picture stays in the library: it may belong to a post.
    const removed = await removeExample(scope.brandId, String(input.assetId));
    if (removed) revalidatePath(`/projects/${scope.projectId}`);
    return { ok: true };
  } catch (error) {
    console.error(
      "[post-style] remove failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: "That didn't work. Try again." };
  }
}

export async function reanalyzePostStyleExampleAction(input: {
  projectId: string;
  assetId: string;
}): Promise<PostStyleResult> {
  try {
    const found = await scopeOf(input?.projectId);
    if (!found) return { ok: false, message: "Project not found." };
    const { userId, scope } = found;
    if (isRateLimited(`${ADD_LIMIT.key}:${userId}`, ADD_LIMIT.max, ADD_LIMIT.windowMs)) {
      return { ok: false, message: SLOW_DOWN };
    }
    const done = await reanalyzeExample(scope, String(input.assetId));
    if (!done) {
      return { ok: false, message: "The picture couldn't be read. Try again." };
    }
    revalidatePath(`/projects/${scope.projectId}`);
    return { ok: true };
  } catch (error) {
    console.error(
      "[post-style] reanalyze failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: "That didn't work. Try again." };
  }
}
