import "server-only";

import { prisma } from "@/lib/prisma";
import type { CommandAttachment } from "@/server/repositories/command.repository";
import { readAsset } from "@/server/storage/asset-storage";

import type { HistoryRow } from "./history";

// Files the client attached in RECENT turns, loaded back so a follow-up like
// "make the logo bigger" still lets the model see the logo instead of only its
// filename. Bounded on purpose: images and PDFs only, the last few turns, a
// handful of files — each one costs input tokens on every later turn.
const MAX_ROWS = 2;
const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

export type HistoryFile = { mimeType: string; data: string };

type StoredAttachment = { assetId?: string; mimeType?: string };

function isVisual(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType &&
    (mimeType.startsWith("image/") || mimeType === "application/pdf"),
  );
}

export async function loadRecentHistoryFiles(
  rows: readonly HistoryRow[],
  excludeId: string,
  projectId: string,
): Promise<Map<string, HistoryFile>> {
  const wanted: string[] = [];
  let rowsUsed = 0;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.id === excludeId || row.source !== "WEB") continue;
    if (!Array.isArray(row.attachments)) continue;
    const ids = (row.attachments as StoredAttachment[]).flatMap((a) =>
      a.assetId && isVisual(a.mimeType) ? [a.assetId] : [],
    );
    if (ids.length === 0) continue;
    wanted.push(...ids);
    rowsUsed += 1;
    if (rowsUsed >= MAX_ROWS || wanted.length >= MAX_FILES) break;
  }
  if (wanted.length === 0) return new Map();

  // Scoped to the project: an assetId stored on a Command is a soft
  // reference, never trusted to point inside this tenant on its own.
  const assets = await prisma.asset.findMany({
    where: { id: { in: wanted.slice(0, MAX_FILES) }, projectId },
    select: { id: true, storageKey: true, mimeType: true },
  });

  // Downloaded together (at most MAX_FILES; one after another they held up
  // every turn), then the byte budget is applied in the same order as before.
  const buffers = await Promise.all(
    assets.map((asset) =>
      readAsset(asset.storageKey).catch((error: unknown) => {
        // A missing file must not fail the turn; the model still sees the
        // "[attached: name]" note from the history text.
        console.error(
          "[chat-history-files] could not read asset",
          asset.id,
          error,
        );
        return null;
      }),
    ),
  );

  const files = new Map<string, HistoryFile>();
  let totalBytes = 0;
  for (const [index, asset] of assets.entries()) {
    const buffer = buffers[index];
    if (!buffer) continue;
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) break;
    files.set(asset.id, {
      mimeType: asset.mimeType,
      data: buffer.toString("base64"),
    });
  }
  return files;
}

// Every file of ONE earlier message, loaded back in its order: an edited
// message is sent again with the files it had (the edit itself is text only).
// Scoped to the project like the history files. A file that can't be read is
// left out; the agent then names it in the message instead (chat-agent.ts).
export async function loadAttachmentBodies(
  attachments: readonly CommandAttachment[],
  projectId: string,
): Promise<HistoryFile[]> {
  if (attachments.length === 0) return [];
  const assets = await prisma.asset.findMany({
    where: { id: { in: attachments.map((a) => a.assetId) }, projectId },
    select: { id: true, storageKey: true, mimeType: true },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset] as const));

  const bodies: HistoryFile[] = [];
  for (const attachment of attachments) {
    const asset = byId.get(attachment.assetId);
    if (!asset) continue;
    try {
      const buffer = await readAsset(asset.storageKey);
      bodies.push({
        mimeType: asset.mimeType,
        data: buffer.toString("base64"),
      });
    } catch (error) {
      console.error(
        "[chat-history-files] could not read asset",
        asset.id,
        error,
      );
    }
  }
  return bodies;
}
