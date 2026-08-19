import { beforeEach, describe, expect, it, vi } from "vitest";

const envMocks = vi.hoisted(() => ({ r2Configured: false }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    R2_ACCOUNT_ID: "acc-1",
    R2_ACCESS_KEY_ID: "key-1",
    R2_SECRET_ACCESS_KEY: "secret-1",
    R2_BUCKET_NAME: "agentelse",
    R2_PUBLIC_URL: "https://storage.agentelse.ai",
  }),
  isIntegrationConfigured: (key: string) =>
    key === "R2" ? envMocks.r2Configured : false,
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMocks);

const s3Mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Mocks.send })),
  PutObjectCommand: vi.fn((input) => ({ input, kind: "put" })),
  GetObjectCommand: vi.fn((input) => ({ input, kind: "get" })),
  DeleteObjectCommand: vi.fn((input) => ({ input, kind: "delete" })),
}));

const {
  putAsset,
  overwriteAsset,
  readAsset,
  deleteAsset,
  resolveDirectPublicUrl,
} = await import("@/server/storage/asset-storage");

beforeEach(() => {
  vi.clearAllMocks();
  envMocks.r2Configured = false;
});

describe("putAsset", () => {
  it("writes to disk with a local-asset:// key when R2 isn't configured", async () => {
    const result = await putAsset(Buffer.from("x"), "png", "image/png");

    expect(result.storageKey).toMatch(/^local-asset:\/\/.+\.png$/);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(s3Mocks.send).not.toHaveBeenCalled();
  });

  it("writes to R2 with an r2:// key when R2 is configured", async () => {
    envMocks.r2Configured = true;

    const result = await putAsset(Buffer.from("x"), "png", "image/png");

    expect(result.storageKey).toMatch(/^r2:\/\/.+\.png$/);
    expect(s3Mocks.send).toHaveBeenCalledTimes(1);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });
});

describe("readAsset / overwriteAsset / deleteAsset — unsafe keys", () => {
  it("rejects a path-escaping local-asset:// key instead of touching the filesystem", async () => {
    await expect(
      readAsset("local-asset://../../../etc/passwd"),
    ).rejects.toThrow();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it("rejects a nested-path local-asset:// key", async () => {
    await expect(readAsset("local-asset://nested/path.png")).rejects.toThrow();
  });

  it("deleteAsset returns false (not throw) for an unsafe key", async () => {
    await expect(deleteAsset("local-asset://../escape.png")).resolves.toBe(
      false,
    );
    expect(fsMocks.rm).not.toHaveBeenCalled();
  });

  it("deleteAsset returns false for an unrecognized scheme", async () => {
    await expect(deleteAsset("mock://placeholder")).resolves.toBe(false);
  });

  it("deleteAsset returns true for a real local delete", async () => {
    fsMocks.rm.mockResolvedValue(undefined);
    await expect(deleteAsset("local-asset://abc.png")).resolves.toBe(true);
  });

  it("overwriteAsset rejects an unsafe R2 key", async () => {
    await expect(
      overwriteAsset("r2://../escape.png", Buffer.from("x"), "image/png"),
    ).rejects.toThrow();
    expect(s3Mocks.send).not.toHaveBeenCalled();
  });
});

describe("resolveDirectPublicUrl", () => {
  it("returns null for local-asset:// (no public URL of its own)", () => {
    expect(resolveDirectPublicUrl("local-asset://abc.png")).toBeNull();
  });

  it("returns the permanent R2 public URL for r2://", () => {
    expect(resolveDirectPublicUrl("r2://abc.png")).toBe(
      "https://storage.agentelse.ai/abc.png",
    );
  });
});
