import { describe, expect, it, vi } from "vitest";

import {
  cachedGoogleAccessToken,
  forgetGoogleAccessTokens,
  googleAccessTokenKey,
} from "./access-token";

// Bu dosyanın kanıtladığı: bir saatlik access token bitişine 5 dk kalana
// kadar yeniden kullanılır, aynı anda gelen istekler tek yenilemeyi bekler
// ve yeniden bağlanınca (yeni şifreli token) önbellek kullanılmaz.

describe("cachedGoogleAccessToken", () => {
  it("reuses a token until five minutes before it expires", async () => {
    let now = 1_000_000;
    const mint = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "t1", expiresIn: 3600 })
      .mockResolvedValueOnce({ accessToken: "t2", expiresIn: 3600 });
    const key = googleAccessTokenKey("cred-a", "enc-a");

    expect(await cachedGoogleAccessToken(key, mint, () => now)).toBe("t1");
    now += 54 * 60_000;
    expect(await cachedGoogleAccessToken(key, mint, () => now)).toBe("t1");
    now += 2 * 60_000;
    expect(await cachedGoogleAccessToken(key, mint, () => now)).toBe("t2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between concurrent callers", async () => {
    let release: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void = () => undefined;
    const mint = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((resolve) => {
          release = resolve;
        }),
    );
    const key = googleAccessTokenKey("cred-b", "enc-b");
    const first = cachedGoogleAccessToken(key, mint);
    const second = cachedGoogleAccessToken(key, mint);
    release({ accessToken: "shared", expiresIn: 3600 });
    expect(await Promise.all([first, second])).toEqual(["shared", "shared"]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("uses a new key after a reconnect and forgets a connection's tokens", async () => {
    expect(googleAccessTokenKey("cred-c", "enc-old")).not.toBe(
      googleAccessTokenKey("cred-c", "enc-new"),
    );

    const mint = vi
      .fn()
      .mockResolvedValue({ accessToken: "t", expiresIn: 3600 });
    const key = googleAccessTokenKey("cred-c", "enc-old");
    await cachedGoogleAccessToken(key, mint);
    forgetGoogleAccessTokens("cred-c");
    await cachedGoogleAccessToken(key, mint);
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
