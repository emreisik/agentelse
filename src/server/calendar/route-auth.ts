import "server-only";

import { NextResponse } from "next/server";

import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Takvim uçlarının ortak kapısı: oturum ve proje üyeliği. Başarısızlıkta
// döndürülecek yanıtı verir; geçerliyse null. Başka projenin varlığı sızmasın
// diye erişim hataları 404 olur (facebook-share ucuyla aynı kural).
export async function denyUnlessProjectMember(
  projectId: string,
): Promise<NextResponse | null> {
  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }
  return null;
}
