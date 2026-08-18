"use server";

import { z } from "zod";

const contactSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address"),
  company: z.string().optional(),
  message: z.string().min(1, "Tell us a bit about what you need"),
});

export type ContactFormValues = z.infer<typeof contactSchema>;

// Phase 1 stub: validates and logs server-side. No email/CRM delivery yet —
// that needs a provider decision (resend/CRM webhook/etc.) before real
// delivery is wired up. The contact page keeps a visible mailto: fallback
// for anyone who lands here before that ships.
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

  return { success: true };
}
