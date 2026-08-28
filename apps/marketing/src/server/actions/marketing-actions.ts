"use server";

import { z } from "zod";

import { sendTelegramMessage } from "@/server/notifications/telegram.service";

const contactSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address"),
  company: z.string().optional(),
  message: z.string().min(1, "Tell us a bit about what you need"),
});

export type ContactFormValues = z.infer<typeof contactSchema>;

// sendTelegramMessage uses Telegram's HTML parse mode — escape user input
// before interpolating it so a submitted name/message can't break the
// markup or inject unintended formatting.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Validates and logs server-side, then notifies the team over Telegram
// (silent no-op if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't configured on
// this deploy — see telegram.service.ts). Delivery failure never blocks the
// response: the contact page also keeps a visible mailto: fallback for
// anyone who lands here before a lead is confirmed received.
export async function submitContactRequest(
  values: ContactFormValues,
): Promise<{ success: true } | { success: false; error: string }> {
  const parsed = contactSchema.safeParse(values);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid submission",
    };
  }

  console.info("[marketing] contact request received", {
    name: parsed.data.name,
    email: parsed.data.email,
    company: parsed.data.company,
  });

  await sendTelegramMessage(
    [
      "<b>New contact request</b>",
      `Name: ${escapeHtml(parsed.data.name)}`,
      `Email: ${escapeHtml(parsed.data.email)}`,
      parsed.data.company
        ? `Company: ${escapeHtml(parsed.data.company)}`
        : null,
      "",
      escapeHtml(parsed.data.message),
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );

  return { success: true };
}
