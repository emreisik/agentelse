import { NextResponse } from "next/server";

import { getOpenAiCredit } from "@/server/billing/openai-credit";
import { requireUser } from "@/server/security/tenant-context";

// Polling target for the header's OpenAiCreditPill — same split as
// agency-status: SSR the first paint (AppShell), poll this JSON endpoint
// afterward. A server action would queue behind the user's own actions, which
// is wrong for a value refreshed every few seconds.
export async function GET() {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credit = await getOpenAiCredit();
  return NextResponse.json(
    { credit },
    { headers: { "cache-control": "no-store" } },
  );
}
