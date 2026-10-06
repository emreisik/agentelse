import { foldForMatch } from "@/lib/text-fold";

// Sorgu gömmeleri (docs/google-search-console-plan.md SC-F4, SK13 (a)):
// text-embedding-3-small, 256 boyut. Vektör SeoQueryEmbedding'de Float32
// little-endian bayt dizisi olarak saklanır. Sahte modda ağ çağrısı yerine
// deterministik karakter üçlüsü (trigram) vektörü kullanılır: benzer yazılan
// sorgular yakın düşer. Saf ve izomorfik.

export const SEO_EMBEDDING_DIMS = 256;

export function encodeVector(vector: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new Uint8Array(buffer);
}

// Boy beklenen boyuta uymuyorsa ya da sonlu olmayan değer varsa null.
export function decodeVector(
  bytes: Uint8Array,
  dims: number = SEO_EMBEDDING_DIMS,
): Float32Array | null {
  if (bytes.byteLength !== dims * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
  }
  return vector;
}

// Boylar farklıysa ya da vektörlerden biri sıfırsa 0.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

// FNV-1a 32 bit (UTF-8 baytları üzerinde).
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Katlanmış metin iki yanından boşlukla doldurulur; her karakter üçlüsü iki
// kovaya (1 ve 0,5 ağırlıkla) düşer, sonra L2 ile birim boya getirilir. Boş
// metin sıfır vektördür (kosinüsü 0).
export function mockEmbedding(
  text: string,
  dims: number = SEO_EMBEDDING_DIMS,
): Float32Array {
  const vector = new Float32Array(dims);
  const body = foldForMatch(text).replace(/\s+/g, " ").trim();
  if (!body || dims <= 0) return vector;
  const chars = Array.from(` ${body} `);
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    const hash = fnv1a32(chars.slice(index, index + 3).join(""));
    vector[hash % dims]! += 1;
    vector[(hash >>> 8) % dims]! += 0.5;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < dims; index += 1) vector[index]! /= norm;
  }
  return vector;
}
