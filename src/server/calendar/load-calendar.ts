import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { CHANNELS, isChannelKey, resolveFormat } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import { stageFromFacts } from "@/lib/calendar/item";
import { sourceOf } from "@/lib/calendar/source";
import type {
  CalendarConnection,
  CalendarItem,
  CalendarPayload,
  ItemFacts,
} from "@/lib/calendar/types";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { CreativeRepository } from "@/server/repositories/creative.repository";

// Yayın görevi olan yetenekler (creative-publish-completion.ts ile aynı küme;
// FACEBOOK_PUBLISH bilerek yok: o bir çapraz paylaşımdır, parçanın kendi
// kanalındaki durumunu değiştirmez).
const PUBLISH_CAPABILITIES: CapabilityKey[] = [
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
];

// Yayın görevlerinin bakılan penceresi: bundan eski bir hata artık "şu an"
// bilgisi sayılmaz.
const TASK_WINDOW_MS = 45 * 24 * 3600 * 1000;

const IN_FLIGHT = new Set([
  "READY",
  "QUEUED",
  "RUNNING",
  "VERIFYING",
  "WAITING_PROVIDER",
]);

type LatestTask = NonNullable<ItemFacts["task"]> & { taskId: string };

// Her parçanın en son yayın görevi (creativeId görev yükünde taşınır).
// Hata metinleri ayrı, yalnız başarısız olanlar için okunur: görev başına iç içe
// sorgu hepsinin iş kayıtlarını çekiyordu.
async function loadLatestPublishTasks(
  projectId: string,
  now: Date,
): Promise<Map<string, LatestTask>> {
  const tasks = await prisma.task.findMany({
    where: {
      projectId,
      capability: { in: PUBLISH_CAPABILITIES },
      createdAt: { gte: new Date(now.getTime() - TASK_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      status: true,
      payload: true,
      completedAt: true,
      updatedAt: true,
    },
  });

  const latest = new Map<string, LatestTask>();
  for (const task of tasks) {
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const creativeId =
      typeof payload.creativeId === "string" ? payload.creativeId : null;
    // En yeni görev kazanır (sorgu createdAt azalan sıralı).
    if (!creativeId || latest.has(creativeId)) continue;

    const at = (task.completedAt ?? task.updatedAt).toISOString();
    if (task.status === "COMPLETED") {
      latest.set(creativeId, {
        taskId: task.id,
        state: "done",
        error: null,
        at,
      });
    } else if (task.status === "FAILED") {
      latest.set(creativeId, {
        taskId: task.id,
        state: "failed",
        error: null,
        at,
      });
    } else if (IN_FLIGHT.has(task.status)) {
      latest.set(creativeId, {
        taskId: task.id,
        state: "running",
        error: null,
        at,
      });
    }
  }

  const failed = [...latest.values()].filter((t) => t.state === "failed");
  if (failed.length > 0) {
    const jobs = await prisma.executionJob.findMany({
      where: { taskId: { in: failed.map((t) => t.taskId) } },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, errorMessage: true },
    });
    const errorOf = new Map<string, string | null>();
    for (const job of jobs) {
      // Görev başına en yeni iş (sıralı olduğundan ilk görülen).
      if (!errorOf.has(job.taskId)) errorOf.set(job.taskId, job.errorMessage);
    }
    for (const task of failed) task.error = errorOf.get(task.taskId) ?? null;
  }
  return latest;
}

function clip(text: string | null | undefined, max: number): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

const CONNECTION_KEYS = [
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
] as const;

async function loadConnections(
  projectId: string,
): Promise<CalendarConnection[]> {
  const targets = await getPublishTargets(projectId).catch(() => []);
  return CONNECTION_KEYS.map((key) => {
    const target = targets.find((t) => t.platform === key);
    let account: string | null = null;
    if (target?.platform === "instagram") {
      account = target.igUsername ? `@${target.igUsername}` : target.pageName;
    } else if (target) {
      account = target.accountLabel;
    }
    return {
      // Facebook kanal kataloğunda yok: kimlik platform yolundan çözülür.
      source: sourceOf(null, key),
      connected: target !== undefined,
      account,
    };
  });
}

// Takvim panosunun tüm verisi: parçalar, her birinin tek durumu ve bağlı
// hesaplar. Hiçbir şey kalıcı yazılmaz (okuma anı bindirmesi). Sayfa ilk
// yüklemede ve hafif yoklama ucu (/api/projects/[id]/calendar) aynısını kullanır.
export async function loadCalendarData(input: {
  projectId: string;
  timezone: string;
  from: Date;
  to: Date;
  now?: Date;
}): Promise<CalendarPayload> {
  const now = input.now ?? new Date();
  const loadedAt = now.getTime();
  const [creatives, connections, scheduleCount, tasks] = await Promise.all([
    CreativeRepository.listForCalendarBoard(input.projectId, {
      from: input.from,
      to: input.to,
    }),
    loadConnections(input.projectId),
    prisma.projectSchedule
      .count({
        where: {
          projectId: input.projectId,
          capability: "INSTAGRAM_PUBLISH",
          enabled: true,
        },
      })
      .catch(() => 0),
    loadLatestPublishTasks(input.projectId, now).catch(
      () => new Map<string, LatestTask>(),
    ),
  ]);
  const scheduleEnabled = scheduleCount > 0;
  const connectedKeys = new Set(
    connections.filter((c) => c.connected).map((c) => c.source.key),
  );

  const items = creatives.map((creative): CalendarItem => {
    const version = creative.versions[0];
    const asset = version?.asset;
    const hasImage = Boolean(
      asset &&
      asset.mimeType.startsWith("image/") &&
      !asset.storageKey.startsWith("mock://"),
    );
    const source = sourceOf(creative.channel, creative.platform);
    const format =
      isChannelKey(creative.channel) && creative.formatKey
        ? resolveFormat(creative.channel, creative.formatKey)
        : undefined;
    const label = isChannelKey(creative.channel)
      ? format
        ? `${CHANNELS[creative.channel].label} · ${format.label}`
        : CHANNELS[creative.channel].label
      : source.label;

    const task = tasks.get(creative.id) ?? null;
    const facts: ItemFacts = {
      status: creative.status,
      hasContent: Boolean(creative.currentVersionId || version),
      platform: creative.platform,
      channel: creative.channel,
      formatKey: creative.formatKey,
      connected: connectedKeys.has(source.key),
      task: task ? { state: task.state, error: task.error, at: task.at } : null,
    };
    const result = stageFromFacts(
      facts,
      creative.scheduledFor,
      scheduleEnabled,
      now,
    );

    const local = creative.scheduledFor
      ? utcToZonedDateTimeLocal(creative.scheduledFor, input.timezone)
      : null;

    return {
      id: creative.id,
      title: creative.title,
      label,
      source,
      glyph: format?.glyph ?? null,
      scheduledFor: creative.scheduledFor?.toISOString() ?? null,
      localDay: local ? local.slice(0, 10) : null,
      localTime: local ? local.slice(11, 16) : null,
      stage: result.stage,
      reason: result.reason,
      overdue: result.overdue,
      movable: result.movable,
      assetId: hasImage && asset ? asset.id : null,
      preview: clip(version?.caption || version?.copy, 160),
      publishedAt:
        result.stage === "published" && task?.state === "done" ? task.at : null,
      facts,
    };
  });

  return { items, connections, scheduleEnabled, loadedAt };
}
