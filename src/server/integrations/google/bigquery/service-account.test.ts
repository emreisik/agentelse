import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BigQueryError } from "./errors";
import {
  BIGQUERY_SCOPE,
  createServiceAccountTokenProvider,
  parseServiceAccountKey,
  signServiceAccountJwt,
  type ServiceAccountKey,
} from "./service-account";

// Bu dosyanın kanıtladığı: servis hesabı anahtarı JSON, base64 JSON ve
// kaçışlı satır sonlarıyla okunur; JWT RS256 ile doğrulanır; token önbelleğe
// alınır, bitmeden 5 dakika önce yenilenir, eşzamanlı çağrılar tek değişim
// yapar ve özel anahtar hiçbir hata mesajında görünmez.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const EMAIL = "reader@project-1.iam.gserviceaccount.com";

function keyJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "service_account",
    client_email: EMAIL,
    private_key: privateKey,
    ...overrides,
  };
}

const KEY: ServiceAccountKey = {
  clientEmail: EMAIL,
  privateKey,
  tokenUri: "https://oauth2.googleapis.com/token",
};

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

afterEach(() => vi.useRealTimers());

describe("parseServiceAccountKey", () => {
  it("reads raw JSON", () => {
    const parsed = parseServiceAccountKey(JSON.stringify(keyJson()));
    expect(parsed?.clientEmail).toBe(EMAIL);
    expect(parsed?.tokenUri).toBe("https://oauth2.googleapis.com/token");
    expect(parsed?.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("reads base64 JSON", () => {
    const raw = Buffer.from(JSON.stringify(keyJson())).toString("base64");
    expect(parseServiceAccountKey(raw)?.clientEmail).toBe(EMAIL);
  });

  it("normalises literal \\n sequences in the private key", () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    const parsed = parseServiceAccountKey(
      JSON.stringify(keyJson({ private_key: escaped })),
    );
    expect(parsed?.privateKey).toBe(privateKey);
  });

  it("returns null for anything that is not a usable service account key", () => {
    expect(parseServiceAccountKey(undefined)).toBeNull();
    expect(parseServiceAccountKey("")).toBeNull();
    expect(parseServiceAccountKey("not json")).toBeNull();
    expect(parseServiceAccountKey("[]")).toBeNull();
    expect(
      parseServiceAccountKey(JSON.stringify(keyJson({ type: "authorized_user" }))),
    ).toBeNull();
    expect(
      parseServiceAccountKey(JSON.stringify(keyJson({ client_email: "" }))),
    ).toBeNull();
    expect(
      parseServiceAccountKey(JSON.stringify(keyJson({ private_key: "garbage" }))),
    ).toBeNull();
  });

  it("only accepts a Google token_uri", () => {
    const custom = parseServiceAccountKey(
      JSON.stringify(keyJson({ token_uri: "https://oauth2.googleapis.com/token2" })),
    );
    expect(custom?.tokenUri).toBe("https://oauth2.googleapis.com/token2");
    const foreign = parseServiceAccountKey(
      JSON.stringify(keyJson({ token_uri: "https://evil.example.com/token" })),
    );
    expect(foreign?.tokenUri).toBe("https://oauth2.googleapis.com/token");
    const plain = parseServiceAccountKey(
      JSON.stringify(keyJson({ token_uri: "http://oauth2.googleapis.com/token" })),
    );
    expect(plain?.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });
});

describe("signServiceAccountJwt", () => {
  it("produces an RS256 JWT that verifies with the public key", () => {
    const now = new Date("2026-10-07T10:00:00.000Z");
    const jwt = signServiceAccountJwt(KEY, { scope: BIGQUERY_SCOPE, now });
    const [header, claims, signature] = jwt.split(".");
    expect(decodePart(header as string)).toEqual({ alg: "RS256", typ: "JWT" });

    const iat = Math.floor(now.getTime() / 1000);
    expect(decodePart(claims as string)).toEqual({
      iss: EMAIL,
      scope: BIGQUERY_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });

    const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
    expect(
      verifier.verify(
        createPublicKey(publicKey),
        Buffer.from(signature as string, "base64url"),
      ),
    ).toBe(true);
  });

  it("honours a custom lifetime and uses only base64url characters", () => {
    const jwt = signServiceAccountJwt(KEY, {
      scope: "s",
      now: new Date(1_000_000 * 1000),
      lifetimeSec: 600,
    });
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = decodePart(jwt.split(".")[1] as string);
    expect(claims.exp).toBe(1_000_000 + 600);
  });
});

describe("createServiceAccountTokenProvider", () => {
  function setup(expiresInSec = 3600) {
    let nowMs = Date.parse("2026-10-07T10:00:00.000Z");
    const exchange = vi.fn(async () => ({
      accessToken: `token-${exchange.mock.calls.length}`,
      expiresInSec,
    }));
    const provider = createServiceAccountTokenProvider({
      key: KEY,
      now: () => new Date(nowMs),
      exchange,
    });
    return {
      provider,
      exchange,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it("exposes the account email and configured flag", () => {
    const { provider } = setup();
    expect(provider.email).toBe(EMAIL);
    expect(provider.configured).toBe(true);
  });

  it("sends a signed assertion to the exchange", async () => {
    const { provider, exchange } = setup();
    await provider.getToken();
    const call = exchange.mock.calls[0] as unknown as [ServiceAccountKey, string];
    expect(call[0].clientEmail).toBe(EMAIL);
    expect(call[1].split(".")).toHaveLength(3);
  });

  it("reuses the cached token until 5 minutes before expiry", async () => {
    const { provider, exchange, advance } = setup(3600);
    expect(await provider.getToken()).toBe("token-1");
    advance(54 * 60_000);
    expect(await provider.getToken()).toBe("token-1");
    expect(exchange).toHaveBeenCalledTimes(1);
    advance(60_000 + 1);
    expect(await provider.getToken()).toBe("token-2");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers", async () => {
    const { provider, exchange } = setup();
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("throws NOT_CONFIGURED without a key", async () => {
    const provider = createServiceAccountTokenProvider({ key: null });
    expect(provider.configured).toBe(false);
    expect(provider.email).toBeNull();
    await expect(provider.getToken()).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("turns a failed exchange into SA_AUTH without leaking the key", async () => {
    const provider = createServiceAccountTokenProvider({
      key: KEY,
      exchange: async () => {
        throw new Error(`invalid_grant ${privateKey}`);
      },
    });
    const error = await provider.getToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BigQueryError);
    expect((error as BigQueryError).code).toBe("SA_AUTH");
    expect((error as BigQueryError).message).not.toContain("PRIVATE KEY");
  });

  it("lets the next call retry after a failed exchange", async () => {
    let fail = true;
    const provider = createServiceAccountTokenProvider({
      key: KEY,
      exchange: async () => {
        if (fail) throw new Error("x");
        return { accessToken: "ok", expiresInSec: 3600 };
      },
    });
    await expect(provider.getToken()).rejects.toBeInstanceOf(BigQueryError);
    fail = false;
    expect(await provider.getToken()).toBe("ok");
  });

  it("reads GOOGLE_BIGQUERY_SA_KEY by default", () => {
    vi.stubEnv("GOOGLE_BIGQUERY_SA_KEY", JSON.stringify(keyJson()));
    expect(createServiceAccountTokenProvider().email).toBe(EMAIL);
    vi.stubEnv("GOOGLE_BIGQUERY_SA_KEY", "");
    expect(createServiceAccountTokenProvider().configured).toBe(false);
    vi.unstubAllEnvs();
  });
});
