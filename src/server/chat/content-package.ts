import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import {
  DELIVERABLE_KEYS,
  DELIVERABLES,
  INSTAGRAM_POST_FORMATS,
  isDeliverableActive,
} from "./deliverables";

// Topic-driven packages: the model drafts the package itself (one structured
// tool call, no extra model call), the client ticks what they want on the
// card, and one click starts production (content-package-actions.ts). Shared
// by the tool and the action so both apply the same rules.

export type ContentPackageCard = Extract<
  IdeaEventCardData,
  { kind: "content-package" }
>;

export const MIN_PACKAGE_ITEMS = 1;
export const MAX_PACKAGE_ITEMS = 5;

export const PackageItemSchema = z.object({
  id: z.string().min(1).max(40),
  deliverable: z.enum(DELIVERABLE_KEYS),
  title: z.string().min(1),
  angle: z.string().min(1),
  contentFormat: z.enum(INSTAGRAM_POST_FORMATS).optional(),
});

export const ContentPackageArgsSchema = z.object({
  topic: z.string().min(1),
  items: z
    .array(PackageItemSchema)
    .min(MIN_PACKAGE_ITEMS)
    .max(MAX_PACKAGE_ITEMS),
});

// Returns a message the MODEL can act on (handed back as the tool result so
// it re-proposes), or null when the package is acceptable.
export function validatePackageItems(
  items: readonly z.infer<typeof PackageItemSchema>[],
): string | null {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) return `Item id "${item.id}" is used twice.`;
    ids.add(item.id);
    if (!isDeliverableActive(item.deliverable)) {
      return `"${item.deliverable}" is not offered by the agency's active departments. Only propose deliverables listed in your context.`;
    }
    if (DELIVERABLES[item.deliverable].needsFormat && !item.contentFormat) {
      return `Item "${item.id}" (${item.deliverable}) needs contentFormat: FEED_PORTRAIT (Post 3:4), STORY, REEL or FEED_SQUARE. Propose FEED_PORTRAIT unless the client asked for another format; they can change it on the card.`;
    }
  }
  return null;
}

export function buildPackageCard(
  args: z.infer<typeof ContentPackageArgsSchema>,
): ContentPackageCard {
  return {
    kind: "content-package",
    topic: args.topic.trim(),
    state: "draft",
    items: args.items.map((item) => ({
      id: item.id,
      deliverable: item.deliverable,
      title: item.title.trim(),
      angle: item.angle.trim(),
      contentFormat: DELIVERABLES[item.deliverable].needsFormat
        ? item.contentFormat
        : undefined,
    })),
  };
}

// Only ONE open package per project can be started, so re-proposing after
// "make it about X" never leaves an older card whose button would duplicate
// the work.
export async function supersedeOpenPackages(
  projectId: string,
  exceptCommandId: string,
): Promise<void> {
  const commands = await prisma.command.findMany({
    where: {
      projectId,
      id: { not: exceptCommandId },
      parsedIntent: { path: ["card", "kind"], equals: "content-package" },
    },
    select: { id: true, parsedIntent: true },
  });
  for (const command of commands) {
    const intent = command.parsedIntent as {
      card?: { state?: string };
    } | null;
    if (intent?.card?.state !== "draft") continue;
    await prisma.command.update({
      where: { id: command.id },
      data: {
        parsedIntent: {
          ...intent,
          card: { ...intent.card, state: "superseded" },
        } as never,
      },
    });
  }
}
