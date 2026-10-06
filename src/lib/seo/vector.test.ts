import { describe, expect, it } from "vitest";

import {
  SEO_EMBEDDING_DIMS,
  cosine,
  decodeVector,
  encodeVector,
  mockEmbedding,
} from "./vector";

describe("encodeVector and decodeVector", () => {
  it("round-trips Float32 little-endian bytes", () => {
    const vector = new Float32Array([0.5, -1.25, 3, 0]);
    const bytes = encodeVector(vector);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(16);
    // 0.5 = 0x3f000000, little-endian.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 0, 0x3f]);
    expect(decodeVector(bytes, 4)).toEqual(vector);
  });

  it("reads a view into a larger buffer", () => {
    const inner = encodeVector(new Float32Array([1, 2]));
    const outer = new Uint8Array(12);
    outer.set(inner, 4);
    expect(decodeVector(outer.subarray(4, 12), 2)).toEqual(
      new Float32Array([1, 2]),
    );
  });

  it("rejects a length mismatch and non-finite values", () => {
    expect(decodeVector(new Uint8Array(10))).toBeNull();
    expect(decodeVector(encodeVector(new Float32Array(4)))).toBeNull();
    expect(decodeVector(encodeVector(new Float32Array([Number.NaN])), 1)).toBe(
      null,
    );
    const full = encodeVector(mockEmbedding("shoes"));
    expect(decodeVector(full)?.length).toBe(SEO_EMBEDDING_DIMS);
  });
});

describe("cosine", () => {
  it("is 0 for zero or mismatched vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(
      0,
    );
    expect(cosine(new Float32Array(3), new Float32Array([1, 2, 3]))).toBe(0);
    expect(
      cosine(new Float32Array([1, 2]), new Float32Array([2, 4])),
    ).toBeCloseTo(1, 6);
  });
});

describe("mockEmbedding", () => {
  it("is deterministic, normalised and folded", () => {
    const a = mockEmbedding("Running Shoes");
    const b = mockEmbedding("  running   shoes ");
    expect(a).toEqual(b);
    expect(a).toHaveLength(SEO_EMBEDDING_DIMS);
    let norm = 0;
    for (const value of a) norm += value * value;
    expect(norm).toBeCloseTo(1, 5);
    expect(cosine(mockEmbedding(""), a)).toBe(0);
  });

  it("puts similar spellings close and unrelated text far", () => {
    const near = cosine(
      mockEmbedding("running shoes"),
      mockEmbedding("running shoe"),
    );
    const far = cosine(
      mockEmbedding("running shoes"),
      mockEmbedding("tax lawyer"),
    );
    expect(near).toBeGreaterThan(0.82);
    expect(far).toBeLessThan(0.82);
  });
});
