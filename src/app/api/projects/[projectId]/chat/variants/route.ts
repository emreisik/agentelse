import { NextResponse } from "next/server";

import { requireUser } from "@/server/security/tenant-context";

// "Make 3 visuals" / "Make 3 more" used to make three paid pictures for one
// piece here. Both were retired: a post has one picture, made by the plan run
// (/chat/plan, docs/works.md "Posts"). A tab still open on an old card learns
// so instead of starting anything. Variants jobs already in flight finish on
// their own (execution-service.ts).
export async function POST() {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "This option was retired: a post has one picture." },
    { status: 410 },
  );
}
