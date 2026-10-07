import { NextResponse } from "next/server";

import { seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import { denyUnlessProjectMember } from "@/server/calendar/route-auth";
import { requireUser } from "@/server/security/tenant-context";
import { loadPublishStatus } from "@/server/seo/apply/read";

// "Publish to WordPress" düğmesinin hafif yoklama ucu (SC-F8): bir makale
// (Creative) için son taslak ve yayın değişikliği. Sıra: (1) bayrak kapalıysa
// 404, hiçbir veritabanı okuması YOK; (2) oturum ve proje üyeliği (401 / 404);
// (3) okuma. Server Action değil: eylemler istemci başına sıralı çalışır ve
// yoklama bir onay tıklamasını bekletirdi.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!seoApplyEnabledFor(projectId)) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const denied = await denyUnlessProjectMember(projectId);
  if (denied) {
    denied.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return denied;
  }

  const creativeId = new URL(request.url).searchParams.get("creativeId") ?? "";
  if (!ID_PATTERN.test(creativeId)) {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  // Oturum denetimden geçti; kimlik rol aramak için bir kez daha okunur.
  const { userId } = await requireUser();
  const view = await loadPublishStatus({ projectId, creativeId, userId });
  if (!view) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  return NextResponse.json(view, { headers: NO_STORE });
}
