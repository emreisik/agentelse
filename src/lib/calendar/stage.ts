// Content Calendar'daki bir parçanın TEK, kullanıcıya okunur durumu (IO yok).
//
// Ham veride birkaç ayrı kaynak var: Creative.status, yayın görevinin durumu
// (kuyrukta / çalışıyor / hata), planlanan zaman, hesabın bağlı olup olmadığı,
// zamanlı yayının açık olup olmadığı, formatın elle paylaşılıp paylaşılmadığı.
// Takvim bunları kullanıcıya tek bir cümleyle söyler: "ne durumda ve benden
// ne bekliyor". Zaman/format/bağlantı kuralları publish-guard.ts'teki
// describePublishLine'dan gelir, burada ikinci bir kopya yazılmaz.

import { CHANNELS, isChannelKey } from "@/lib/content-channels";
import {
  describePublishLine,
  publishTimingOf,
} from "@/lib/works/publish-guard";

export type CalendarStage =
  | "failed"
  | "missed"
  | "held"
  | "needs-approval"
  | "needs-content"
  | "scheduled"
  | "publishing"
  | "manual"
  | "published"
  | "rejected";

// Özet şeridinde ve süzgeçte gösterim sırası: önce dikkat isteyenler.
export const STAGE_ORDER: readonly CalendarStage[] = [
  "failed",
  "missed",
  "held",
  "needs-approval",
  "needs-content",
  "scheduled",
  "publishing",
  "manual",
  "published",
  "rejected",
];

export type StageTone =
  "positive" | "active" | "waiting" | "neutral" | "danger" | "special";

export const STAGE_META: Record<
  CalendarStage,
  { label: string; hint: string; tone: StageTone }
> = {
  failed: {
    label: "Failed",
    hint: "The post was sent but the platform refused it",
    tone: "danger",
  },
  missed: {
    label: "Missed",
    hint: "Its time passed and it was never posted",
    tone: "danger",
  },
  held: {
    label: "On hold",
    hint: "Approved, but something stops it from going out",
    tone: "waiting",
  },
  "needs-approval": {
    label: "Needs approval",
    hint: "Waiting for your OK before it can go out",
    tone: "waiting",
  },
  "needs-content": {
    label: "Needs content",
    hint: "A planned slot with nothing made for it yet",
    tone: "neutral",
  },
  scheduled: {
    label: "Scheduled",
    hint: "Approved — goes out by itself at its time",
    tone: "active",
  },
  publishing: {
    label: "Publishing",
    hint: "Being sent to the platform right now",
    tone: "active",
  },
  manual: {
    label: "Post manually",
    hint: "Approved — it doesn't go out by itself, you post it",
    tone: "special",
  },
  published: {
    label: "Published",
    hint: "Posted",
    tone: "positive",
  },
  rejected: {
    label: "Rejected",
    hint: "Not approved — revise it or drop it",
    tone: "danger",
  },
};

// En son yayın görevinin özeti. Görev yoksa null.
export type PublishTaskState = {
  state: "running" | "failed" | "done";
  error?: string | null;
  // Görevin bittiği an. Hata durumunda, parçanın hatadan SONRA gelecekte yeni
  // bir zamana taşınıp taşınmadığını anlamak için kullanılır.
  at?: Date;
};

export type StageInput = {
  // CreativeStatus
  status: string;
  hasContent: boolean;
  // Büyük harf SocialPlatform ("INSTAGRAM") ya da null.
  platform: string | null;
  channel: string | null;
  formatKey: string | null;
  scheduledFor: Date | null;
  // Parçanın platformunda aktif bir bağlantı var mı.
  connected: boolean;
  scheduleEnabled: boolean;
  publishTask: PublishTaskState | null;
  now: Date;
};

export type StageResult = {
  stage: CalendarStage;
  // Neden bu durumda ve ne yapılmalı; yoksa null.
  reason: string | null;
  // Planlanan zamanı geçmiş ve hâlâ yola çıkmamış.
  overdue: boolean;
  // Başka güne taşınabilir mi (yayınlanmış ya da yayınlanıyorsa hayır).
  movable: boolean;
};

function platformLabel(input: StageInput): string {
  if (isChannelKey(input.channel)) return CHANNELS[input.channel].label;
  if (!input.platform) return "The account";
  const lower = input.platform.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function result(
  stage: CalendarStage,
  reason: string | null,
  input: StageInput,
): StageResult {
  const timing = publishTimingOf(input.scheduledFor, input.now);
  const passed = timing === "due" || timing === "stale";
  return {
    stage,
    reason,
    overdue:
      passed &&
      stage !== "published" &&
      stage !== "publishing" &&
      stage !== "scheduled" &&
      stage !== "rejected",
    movable: stage !== "published" && stage !== "publishing",
  };
}

export function deriveStage(input: StageInput): StageResult {
  if (input.status === "PUBLISHED") return result("published", null, input);
  if (input.status === "REJECTED") {
    return result(
      "rejected",
      "Not approved. Open it to revise, or move it to another day.",
      input,
    );
  }

  if (input.status !== "APPROVED") {
    // DRAFT / IN_REVIEW
    if (!input.hasContent) {
      return result(
        "needs-content",
        "Nothing has been made for this slot yet.",
        input,
      );
    }
    return result(
      "needs-approval",
      input.scheduledFor
        ? "Approve it so it can go out at its time."
        : "Approve it, then pick a day and time.",
      input,
    );
  }

  // APPROVED: önce hattın gerçek durumu, sonra zaman kuralları.
  const task = input.publishTask;
  if (task?.state === "running") {
    return result("publishing", "Being sent to the platform now.", input);
  }
  // Hata, o yayın denemesine aittir: parça hatadan SONRA, gelecekte yeni bir
  // zamana taşındıysa yeniden planlanmış demektir, "başarısız" sayılmaz.
  // Hatanın ne zaman olduğu bilinmiyorsa (`at` yok) hata asla gizlenmez.
  const replanned =
    task?.state === "failed" &&
    task.at !== undefined &&
    input.scheduledFor !== null &&
    input.scheduledFor.getTime() > Math.max(task.at.getTime(), input.now.getTime());
  if (task?.state === "failed" && !replanned) {
    return result(
      "failed",
      task.error
        ? `The platform said: ${task.error}`
        : "The last attempt failed. Open it to try again.",
      input,
    );
  }

  const line = describePublishLine({
    stage: "APPROVED",
    facts: {
      status: input.status,
      platform: input.platform,
      // Plansız eski parçalarda kanal yok: bağlantı kapısı yine de platformdan
      // çalışsın.
      channel: input.channel ?? input.platform?.toLowerCase() ?? null,
      formatKey: input.formatKey,
      hasAsset: true,
      scheduledFor: input.scheduledFor,
      connectedPlatforms: new Set(
        input.connected && input.platform ? [input.platform.toLowerCase()] : [],
      ),
      scheduleEnabled: input.scheduleEnabled,
    },
    now: input.now,
  });
  const timing = publishTimingOf(input.scheduledFor, input.now);

  switch (line?.kind) {
    case "locked":
      return result(
        "held",
        `${platformLabel(input)} isn't connected, so it can't go out. Connect it in Integrations.`,
        input,
      );
    case "manual":
      return input.scheduledFor && timing !== "future"
        ? result(
            "missed",
            "Its time passed. Post it, then mark it as posted.",
            input,
          )
        : result(
            "manual",
            input.scheduledFor
              ? "This one doesn't go out by itself. You post it at its time."
              : "This one doesn't go out by itself. Pick a day, then post it.",
            input,
          );
    case "scheduled":
      if (!line.released) {
        return result(
          "held",
          "Scheduled posting is off, so it won't go out on its own. Turn it on in Settings.",
          input,
        );
      }
      return result(
        "scheduled",
        timing === "future" ? null : "Due now. It goes out on the next check.",
        input,
      );
    case "held":
      if (line.reason === "no-time") {
        return result("held", "Pick a day and time so it can go out.", input);
      }
      // past-time: bayat mı yoksa zamanlı yayın mı kapalı?
      if (timing === "due" && !input.scheduleEnabled) {
        return result(
          "held",
          "Scheduled posting is off, so it won't go out on its own. Turn it on in Settings.",
          input,
        );
      }
      return result(
        "missed",
        "Its time passed more than a day ago and it wasn't posted. Move it to a new time.",
        input,
      );
    default:
      return result("held", "Open it to see what's needed.", input);
  }
}
