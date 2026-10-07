import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { GoogleKeyRotation } from "./key-rotation";
import {
  decryptGoogleSecret,
  encryptGoogleSecret,
  googleSecretPrefixFor,
} from "./secret";

// Anahtar döndürme gerçek Postgres'e karşı: iki satır aynı eski şifreli metni
// paylaşır; döndürmeden sonra ikisi de güncel anahtarla yazılmış ve hâlâ eşit
// olmalı, çözülünce ilk token çıkmalı, boş şifreli metne dokunulmamalı.

describeIntegration("Google key rotation", () => {
  const runId = randomUUID().slice(0, 8);
  const ring = `k2:${randomBytes(32).toString("hex")},k1:${randomBytes(32).toString("hex")}`;
  const saved = process.env.GOOGLE_TOKEN_KEYS;
  let fixtures: AgencyFixture[] = [];

  beforeAll(async () => {
    process.env.GOOGLE_TOKEN_KEYS = ring;
    fixtures = await Promise.all(
      [1, 2, 3].map((n) => createAgencyFixture(`rot-${runId}-${n}`)),
    );
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.GOOGLE_TOKEN_KEYS;
    else process.env.GOOGLE_TOKEN_KEYS = saved;
    for (const fixture of fixtures) {
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  }, 60_000);

  it("rewrites legacy rows with the current key and keeps shared ciphertexts equal", async () => {
    // Eski anahtarla (k1) yazılmış bir şifreli metin: halkada k1 var.
    const k1Only = `k1:${ring.split("k1:")[1]}`;
    process.env.GOOGLE_TOKEN_KEYS = k1Only;
    const shared = encryptGoogleSecret("shared-token");
    process.env.GOOGLE_TOKEN_KEYS = ring;
    const [a, b, c] = fixtures;
    if (!a || !b || !c) throw new Error("fixtures missing");
    const make = (
      f: AgencyFixture,
      provider: string,
      encryptedSecret: string,
      status: "ACTIVE" | "REVOKED",
    ) =>
      prisma.integrationCredential.create({
        data: {
          workspaceId: f.workspaceId,
          projectId: f.projectId,
          brandId: f.brandId,
          provider,
          encryptedSecret,
          status,
        },
      });
    const rowA = await make(a, "google_analytics", shared, "ACTIVE");
    const rowB = await make(b, "google_search_console", shared, "ACTIVE");
    const rowC = await make(c, "google_analytics", "", "REVOKED");

    const before = await GoogleKeyRotation.status();
    expect(before?.currentKeyId).toBe("k2");
    expect(before?.otherRows).toBeGreaterThanOrEqual(2);

    const result = await GoogleKeyRotation.rotateOnce(100);
    // `failed` küresel sayaçtır: tam paket koşusunda başka testlerin bıraktığı
    // çözülemeyen mock satırları da sayılır; burada yalnız kendi satırlarımız.
    expect(result.rows).toBeGreaterThanOrEqual(2);

    const [afterA, afterB, afterC] = await Promise.all(
      [rowA, rowB, rowC].map((row) =>
        prisma.integrationCredential.findUniqueOrThrow({ where: { id: row.id } }),
      ),
    );
    expect(afterA?.encryptedSecret.startsWith(googleSecretPrefixFor("k2"))).toBe(true);
    expect(afterA?.encryptedSecret).toBe(afterB?.encryptedSecret);
    expect(decryptGoogleSecret(afterA?.encryptedSecret ?? "")).toBe("shared-token");
    expect(afterC?.encryptedSecret).toBe("");

    const after = await GoogleKeyRotation.status();
    expect(after?.currentRows).toBeGreaterThanOrEqual(2);
  });
});
