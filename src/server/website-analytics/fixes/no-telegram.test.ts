import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Bu dosyanın kanıtladığı (statik koruma): GA-F7 onay ve Task metinleri hiçbir
// yolla Telegram'a gitmez. Karar bildiricisi CRITICAL_CHANGE_APPROVAL için erken
// döner, Task tamamlandı/başarısız bildirimi ANALYTICS_EDIT'i atlar, onay isteği
// notify:false ile kurulur ve Telegram gönderen her modül bilinen listededir:
// yeni bir gönderici çıkarsa test, Task/Onay başlığı taşıyıp taşımadığına bakılsın
// diye kırılır.

const ROOT = path.resolve(__dirname, "../../../..");

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SENDER_PATTERN =
  /sendTelegramMessage|notifyProjectTelegram|sendApprovalRequestToTelegram|notifyApprovalDecision|sendPublishPromptToTelegram|telegramSendMessage|telegramSendPhoto/;

// Telegram'a yazan modüller ve neden güvenli oldukları. Yeni bir dosya
// buraya girmeden eklenirse test kırılır.
const KNOWN_SENDERS: Record<string, string> = {
  "src/lib/monitoring/site-alert-text.ts": "sabit, rakamsız uyarı metni",
  "src/server/monitoring/site-alerts.ts": "sabit uyarı metni; GA uyarıları CRITICAL olmaz",
  "src/server/ads/guard/alerts.ts": "Meta reklam uyarıları; Task/Onay başlığı taşımaz",
  "src/server/actions/telegram-actions.ts": "bağlantı sınama mesajı",
  "src/server/commands/approval-decisions.ts": "yayın istemi (creative); ANALYTICS_EDIT yayın değildir",
  "src/server/integrations/telegram-approval-poller.ts": "gelen düğme geri çağrıları",
  "src/server/integrations/telegram-client.ts": "HTTP istemcisi",
  "src/server/notifications/project-telegram-notifier.ts": "gönderici tanımı",
  "src/server/notifications/telegram-approval-notifier.ts": "onay bildirici tanımı (CRITICAL_CHANGE_APPROVAL korumalı)",
  "src/server/notifications/telegram.service.ts": "sistem uyarısı gönderici tanımı",
  "src/server/repositories/approval.repository.ts": "istek notify:false ile kapatılır; karar bildirici korumalı",
  "src/server/repositories/dead-letter.repository.ts": "ExecutionJob hataları; ANALYTICS_EDIT hiç ExecutionJob üretmez",
  "src/server/repositories/human-intervention.repository.ts": "tarayıcı insan müdahalesi; ANALYTICS_EDIT tarayıcı kullanmaz",
  "src/server/repositories/task.repository.ts": "tamamlandı/başarısız bildirimi ANALYTICS_EDIT'i atlar",
};

describe("GA-F7 never reaches Telegram", () => {
  it("notifyApprovalDecision returns early for CRITICAL_CHANGE_APPROVAL, before any Telegram lookup", () => {
    const source = read("src/server/notifications/telegram-approval-notifier.ts");
    const start = source.indexOf("export async function notifyApprovalDecision");
    expect(start, "notifyApprovalDecision not found").toBeGreaterThan(-1);
    const body = source.slice(start);
    const guard = body.indexOf("CRITICAL_CHANGE_APPROVAL");
    const lookup = body.indexOf("findActiveTelegramCredential");
    expect(
      guard,
      "notifyApprovalDecision must return early for CRITICAL_CHANGE_APPROVAL (GA-F7 shared edit)",
    ).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(lookup);
    expect(body.slice(guard, lookup)).toContain("return");
  });

  it("the Task completed/failed notice skips ANALYTICS_EDIT", () => {
    const source = read("src/server/repositories/task.repository.ts");
    const call = source.indexOf("await notifyProjectTelegram(");
    expect(call, "task completion notice not found").toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, call - 500), call);
    expect(
      before,
      "TaskRepository.transition must skip ANALYTICS_EDIT before notifyProjectTelegram (GA-F7 shared edit)",
    ).toContain("ANALYTICS_EDIT");
  });

  it("the approval request ping is switched off at creation", () => {
    expect(read("src/server/website-analytics/fixes/task-approval.ts")).toMatch(
      /notify:\s*false/,
    );
    const repository = read("src/server/repositories/approval.repository.ts");
    expect(repository).toMatch(
      /if \(input\.notify \?\? true\) await sendApprovalRequestToTelegram/,
    );
  });

  it("every module that sends to Telegram is a known, reviewed sender", () => {
    const found = walk(path.join(ROOT, "src"))
      .filter((file) => SENDER_PATTERN.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();
    const unknown = found.filter((file) => !(file in KNOWN_SENDERS));
    expect(
      unknown,
      `New Telegram sender(s) found: check that they cannot carry an ANALYTICS_EDIT Task title or a CRITICAL_CHANGE_APPROVAL, then add them to KNOWN_SENDERS: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
});
