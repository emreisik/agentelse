import { describe, expect, it, vi } from "vitest";

import { isCandidateId } from "@/lib/guided-discovery/contract";

vi.mock("server-only", () => ({}));

const { candidateIdFor } = await import("./ids");

describe("candidateIdFor", () => {
  it("is stable, case-insensitive and matches the id shape", () => {
    const a = candidateIdFor("p1", "services", "Teeth whitening");
    expect(a).toBe(candidateIdFor("p1", "services", "  teeth WHITENING "));
    expect(isCandidateId(a)).toBe(true);
  });

  it("differs per project, field and text", () => {
    const base = candidateIdFor("p1", "services", "Teeth whitening");
    expect(candidateIdFor("p2", "services", "Teeth whitening")).not.toBe(base);
    expect(candidateIdFor("p1", "products", "Teeth whitening")).not.toBe(base);
    expect(candidateIdFor("p1", "services", "Implants")).not.toBe(base);
  });
});
