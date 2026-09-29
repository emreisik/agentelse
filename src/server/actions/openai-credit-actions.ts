"use server";

import { requireUser } from "@/server/security/tenant-context";
import {
  getOpenAiCredit,
  type OpenAiCredit,
} from "@/server/billing/openai-credit";

export async function refreshOpenAiCreditAction(): Promise<OpenAiCredit | null> {
  await requireUser();
  return getOpenAiCredit();
}
