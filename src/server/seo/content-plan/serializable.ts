import "server-only";

// Serializable işlemlerin tek yeniden deneme yardımcısı (SC-F7). Planlayıcı,
// slot taşıma/atlama ve placeSeoArticle aynı satırlara aynı anda yazabilir;
// Postgres bunu 40001 (Prisma P2034) ile reddeder. Yalnız bu hata bir kez
// yeniden denenir; başka her hata olduğu gibi yukarı çıkar.

export function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; meta?: { code?: unknown } };
  return (
    record.code === "P2034" ||
    record.code === "40001" ||
    record.meta?.code === "40001"
  );
}

export async function withSerializableRetry<T>(
  run: () => Promise<T>,
  retries = 1,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= retries) throw error;
      attempt += 1;
    }
  }
}
