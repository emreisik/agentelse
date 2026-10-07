import { NextResponse } from "next/server";

import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  currentLocalMonth,
  loadContentPlanView,
} from "@/server/seo/content-plan/store";

// SEO yol haritası kartındaki canlı "This month's articles" bloğu planı bu
// uçtan tembel yükler (SC-F7, docs/search-content-plan.md). Geçmiş ayın
// yol haritası değişmez bir anlık görüntüdür; bu yüzden yanıt, projenin
// şimdiki yerel ayını da taşır ve istemci yalnız ay tutuyorsa canlı planı
// çizer. Disconnect ya da "Delete stored data" sonrası plan hemen kaybolsun
// diye HER yanıt önbelleğe alınmaz.

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: NO_STORE },
  );
}

// Hata yanıtı da önbelleğe alınmaz; ayrıntı istemciye gitmez.
function serverError() {
  return NextResponse.json(
    { error: "Something went wrong" },
    { status: 500, headers: NO_STORE },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  // Bayrak ve izin listesi yalnız ortamdan okunur: kapalıyken oturuma ve
  // veritabanına hiç dokunulmaz.
  if (!seoContentPlanActiveFor(projectId)) return notFound();

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) return notFound();
    return serverError();
  }

  // Geçersiz ?month= yok sayılır (şimdiki ay okunur).
  const requested = new URL(request.url).searchParams.get("month");
  const month =
    requested !== null && MONTH_PATTERN.test(requested) ? requested : undefined;

  try {
    const now = new Date();
    const [plan, currentMonth] = await Promise.all([
      loadContentPlanView(projectId, { ...(month ? { month } : {}), now }),
      currentLocalMonth(projectId, now),
    ]);
    return NextResponse.json({ plan, currentMonth }, { headers: NO_STORE });
  } catch {
    return serverError();
  }
}
