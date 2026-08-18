"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  TelegramApiError,
  telegramDeleteWebhook,
  telegramGetChat,
  telegramGetMe,
  telegramSendMessage,
} from "@/server/integrations/telegram-client";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Telegram'ın kendi hata metinlerini kelimesi kelimesine göstermek yerine,
// ilk kurulumda hemen herkesin takıldığı birkaç bilinen durum için Türkçe,
// eylemsel bir ipucu ekliyoruz — hatanın kendisi hâlâ görünür (uydurma bir
// mesajla değiştirilmiyor), sadece "şimdi ne yapmalıyım" cevabı ekleniyor.
function describeTelegramError(error: unknown): string {
  if (!(error instanceof TelegramApiError)) {
    return error instanceof Error ? error.message : "İşlem başarısız";
  }
  const raw = error.message;
  const lower = raw.toLowerCase();
  if (lower.includes("chat not found")) {
    return (
      `Telegram: ${raw} — bot bu sohbeti göremiyor. Botu hedef kanala/gruba ` +
      `yönetici olarak eklediniz mi? Özel (herkese açık olmayan) kanal/` +
      `gruplarda @kullaniciadi çalışmaz, sayısal ID gerekir (genelde "-100" ` +
      `ile başlar) — ID'yi bulmak için hedef sohbetten bir mesajı ` +
      `@userinfobot'a yönlendirebilirsiniz.`
    );
  }
  if (lower.includes("unauthorized")) {
    return `Telegram: ${raw} — bot token'ı geçersiz. @BotFather'dan aldığınız token'ı tekrar kontrol edin.`;
  }
  if (
    lower.includes("bot was blocked") ||
    lower.includes("bot is not a member")
  ) {
    return `Telegram: ${raw} — bot bu sohbetten çıkarılmış/engellenmiş, yeniden eklemeniz gerekiyor.`;
  }
  return `Telegram: ${raw}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeTelegramError(error) };
}

// Kullanıcılar sohbet ID'sini genelde bir yerden kopyala-yapıştır yapıyor
// (bu uygulamanın kendi sohbetinden, notlardan, vb.) — kaynak metin
// biçimlendirmesi düz tireyi (-) sık sık en dash/em dash/minus sign gibi
// görünüşte aynı ama Telegram'ın API'sinin tanımadığı unicode karakterlere
// çeviriyor; bu da hiçbir görünür fark olmadan "chat not found" hatasına
// yol açıyor. Bilinen tüm varyantları (hyphen/non-breaking hyphen/figure
// dash/en dash/em dash/horizontal bar/minus sign, U+2010..U+2015 ve
// U+2212) düz ASCII tireye normalize ediyoruz. Karakter kodları hex
// kaçış diziसi (\uXXXX) olarak yazıldı, gerçek glifler olarak değil —
// böylece bu regex'in kaynak kodu, önlemeye çalıştığı kopyala-yapıştır
// bozulmasının kendisine kurban gitmiyor.
const DASH_CODE_POINTS = [
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212,
];
const DASH_VARIANTS_RE = new RegExp(
  `[${DASH_CODE_POINTS.map((cp) => String.fromCodePoint(cp)).join("")}]`,
  "g",
);

function normalizeChatId(value: string): string {
  return value.trim().replace(DASH_VARIANTS_RE, "-");
}

function parseAllowedApproverIds(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Token'ı ve chat id'yi Telegram'ın kendi API'sine karşı doğrular — ikisi
// de gerçekten çalışmıyorsa hiçbir şey kaydedilmez, sahte bir "bağlandı"
// durumu asla üretilmez.
export async function connectTelegramAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const botToken = String(formData.get("botToken") ?? "").trim();
    const chatId = normalizeChatId(String(formData.get("chatId") ?? ""));
    const allowedApproverIds = parseAllowedApproverIds(
      String(formData.get("allowedApproverIds") ?? ""),
    );
    if (!botToken || !chatId) {
      return { ok: false, message: "Bot token ve sohbet ID'si gerekli" };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const bot = await telegramGetMe(botToken);
    const chat = await telegramGetChat(botToken, chatId);
    // Olası eski bir webhook varsa `getUpdates` (onay butonları polling'i)
    // ile çakışmasın diye — bkz. src/server/integrations/telegram-approval-poller.ts.
    await telegramDeleteWebhook(botToken);

    // Metadata'nın tamamını üzerine yazmak yerine mevcutla birleştiriyoruz —
    // aksi halde her yeniden bağlanma poller'ın yazdığı
    // `telegramUpdateOffset`'i sessizce silerdi.
    const existing = await prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: "telegram" } },
    });
    const existingMetadata = (existing?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const metadata = {
      ...existingMetadata,
      chatId,
      chatTitle: chat.title ?? chat.username ?? chatId,
      allowedApproverIds,
    };

    const credential = await prisma.integrationCredential.upsert({
      where: { projectId_provider: { projectId, provider: "telegram" } },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        provider: "telegram",
        accountLabel: `@${bot.username}`,
        encryptedSecret: encryptSecret(botToken),
        metadata,
        status: "ACTIVE",
      },
      update: {
        accountLabel: `@${bot.username}`,
        encryptedSecret: encryptSecret(botToken),
        metadata,
        status: "ACTIVE",
      },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.connected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: "telegram" },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// connectTelegramAction'ın aksine bot token istemiyor — mevcut bağlantının
// zaten doğrulanmış kimlik bilgilerine dokunmadan sadece onay yetkilisi
// listesini günceller. Kullanıcı token'ı elde tutmadan (örn. ilk kurulumdan
// haftalar sonra) sadece "kendi ID'mi ekleyeyim" diyebilsin diye ayrı bir
// action — connectTelegramAction'ı tekrar çağırmak token'ı yeniden
// yapıştırmayı zorunlu kılardı.
export async function updateTelegramApproversAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const allowedApproverIds = parseAllowedApproverIds(
      String(formData.get("allowedApproverIds") ?? ""),
    );

    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: "telegram" } },
    });
    if (!credential) {
      return { ok: false, message: "Telegram bağlantısı bulunamadı" };
    }

    const existingMetadata = (credential.metadata ?? {}) as Record<
      string,
      unknown
    >;
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: { ...existingMetadata, allowedApproverIds } },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function sendTelegramTestMessageAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram" },
    });
    if (!credential) {
      return { ok: false, message: "Telegram bağlantısı bulunamadı" };
    }
    const metadata = (credential.metadata ?? {}) as { chatId?: string };
    if (!metadata.chatId) {
      return { ok: false, message: "Kayıtlı sohbet ID'si yok" };
    }

    const token = decryptSecret(credential.encryptedSecret);
    await telegramSendMessage(
      token,
      metadata.chatId,
      "✅ Hub Connect test mesajı — bu entegrasyon çalışıyor.",
    );

    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectTelegramAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram" },
    });
    if (!credential) return { ok: true };

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { status: "REVOKED" },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: "telegram" },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
