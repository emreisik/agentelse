"use server";

import { contactSchema, type ContactFormValues } from "@/lib/contact-schema";
import { CONTACT_EMAIL } from "@/lib/site";
import { sendTelegramMessage } from "@/server/notifications/telegram.service";

// Validates and logs server-side, then notifies the team over Telegram (plain
// text; a long message goes out in several pieces, see telegram.service.ts).
// A message Telegram did not take is never answered with "we got it": the
// visitor is asked to email instead. Without TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID on this deploy the form still succeeds (a missing optional
// integration must not break it), and the whole request is written to the
// server log so it is not lost.
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
  const { name, email, company, message } = parsed.data;

  console.info("[marketing] contact request received", {
    name,
    email,
    company,
  });

  const delivery = await sendTelegramMessage(
    [
      "New contact request",
      `Name: ${name}`,
      `Email: ${email}`,
      company ? `Company: ${company}` : null,
      "",
      message,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );

  if (delivery === "failed") {
    return {
      success: false,
      error: `We couldn't send your message. Please try again, or email us at ${CONTACT_EMAIL}.`,
    };
  }
  if (delivery === "not-configured") {
    console.warn(
      "[marketing] contact request not delivered: Telegram is not configured on this deploy",
      { name, email, company, message },
    );
  }
  return { success: true };
}
