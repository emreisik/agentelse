import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F7 paylaşılan düzenleme): Task tamamlandı/başarısız
// Telegram bildirimi ANALYTICS_EDIT görevlerinde atlanır (başlık GA yapılandırması
// taşır); diğer yeteneklerde gönderilmeye devam eder.

const taskFindFirst = vi.fn();
const taskUpdate = vi.fn();
const notifyProjectTelegram = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { task: { findFirst: taskFindFirst, update: taskUpdate } },
}));
vi.mock("@/server/repositories/agency-trigger.repository", () => ({
  AgencyTriggerRepository: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {},
}));
// Sohbet olayı yolu bu testin konusu değil: yaratıcı yetenek erken döner.
vi.mock("@/server/execution/execution-policy", () => ({
  ExecutionPolicy: { isCreative: () => true, isPublish: () => false },
}));
vi.mock("@/server/execution/plan-creative-link", () => ({
  fillPlanCreativeWithText: vi.fn(),
  planCreativeIdOf: vi.fn(),
}));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram,
}));

const { TaskRepository } = await import("./task.repository");

function taskRow(capability: string) {
  return {
    id: "task-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    title: "Change something",
    capability,
    status: "RUNNING",
    startedAt: new Date(),
    completedAt: null,
    departmentKey: null,
    payload: null,
    createdByType: "SYSTEM",
    workPlanId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyProjectTelegram.mockResolvedValue(undefined);
  taskUpdate.mockImplementation(async ({ data }: { data: object }) => ({
    ...taskRow("X"),
    title: "Change something",
    ...data,
  }));
});

describe("TaskRepository.transition: Telegram notice", () => {
  it.each(["COMPLETED", "FAILED"] as const)(
    "does not notify Telegram when an ANALYTICS_EDIT task is %s",
    async (to) => {
      taskFindFirst.mockResolvedValue(taskRow("ANALYTICS_EDIT"));
      await TaskRepository.transition("task-1", "p-1", to);
      expect(taskUpdate).toHaveBeenCalledTimes(1);
      expect(notifyProjectTelegram).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["COMPLETED", "✅ Task completed: Change something"],
    ["FAILED", "❌ Task failed: Change something"],
  ] as const)(
    "still notifies Telegram for another capability when %s",
    async (to, text) => {
      taskFindFirst.mockResolvedValue(taskRow("SEO_ARTICLE_WRITE"));
      await TaskRepository.transition("task-1", "p-1", to);
      expect(notifyProjectTelegram).toHaveBeenCalledWith("p-1", text);
    },
  );
});

// SC-F8: işaretli (payload.seoApply) WEBSITE_UPDATE görevi de Telegram'a gitmez;
// işaretsiz WEBSITE_UPDATE eskisi gibi bildirir.
describe("TaskRepository.transition: seo-apply marker", () => {
  const marked = () => ({
    ...taskRow("WEBSITE_UPDATE"),
    payload: { seoApply: { v: 1, changeId: "c1", kind: "TITLE_META" } },
  });

  it.each(["COMPLETED", "FAILED"] as const)(
    "does not notify Telegram when a marked WEBSITE_UPDATE task is %s",
    async (to) => {
      taskFindFirst.mockResolvedValue(marked());
      await TaskRepository.transition("task-1", "p-1", to);
      expect(taskUpdate).toHaveBeenCalledTimes(1);
      expect(notifyProjectTelegram).not.toHaveBeenCalled();
    },
  );

  it("still notifies Telegram for an unmarked WEBSITE_UPDATE task", async () => {
    taskFindFirst.mockResolvedValue(taskRow("WEBSITE_UPDATE"));
    await TaskRepository.transition("task-1", "p-1", "COMPLETED");
    expect(notifyProjectTelegram).toHaveBeenCalledWith(
      "p-1",
      "✅ Task completed: Change something",
    );
  });
});
