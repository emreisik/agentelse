import { z } from "zod";

// Shared by the contact form (client validation) and its server action — a
// "use server" file can only export async functions, so the schema lives here.
export const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("Enter a valid email address").max(320),
  company: z.string().trim().max(200).optional(),
  message: z
    .string()
    .trim()
    .min(1, "Tell us a bit about what you need")
    .max(5000),
});

export type ContactFormValues = z.infer<typeof contactSchema>;
