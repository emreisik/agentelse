// Oturumsuz (herkese açık) uçlarda gövdeyi en çok `maxBytes` kadar okur; aşarsa null.
// Content-Length yalnız hızlı ret içindir (yalan söyleyebilir): asıl sınır, okunan
// bayt sayısıdır.
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}
